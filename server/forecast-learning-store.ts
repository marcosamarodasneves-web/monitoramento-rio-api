import type { SupabaseClient } from '@supabase/supabase-js';
import { ADAPTIVE_MODEL_VERSION, initialLearningState, learnFromOutcome, type LearningState } from './forecast-adaptive-model';

/** No treinamento, o alvo já foi observado e a janela de comparação terminou. */
export async function learnVerifiedForecasts(db: SupabaseClient, now = Date.now()) {
  const pending = await db.from('central_river_forecasts')
    .select('id,bridge,horizon_h,base_time,target_time,current_level,predicted_level,actual_level,actual_time,details')
    .eq('model_version', ADAPTIVE_MODEL_VERSION).eq('learning_applied', false)
    .in('outcome', ['dentro', 'quase', 'fora'])
    .lte('target_time', new Date(now - 10 * 60000).toISOString())
    .order('target_time').order('id').limit(100);
  if (pending.error) throw pending.error;
  let applied = 0, conflicts = 0, skipped = 0;
  for (const row of pending.data ?? []) {
    const frozen = row.details?.adaptive?.horizons?.[String(row.horizon_h)];
    if (!frozen?.candidates || !['stable','rising','falling','turning'].includes(frozen.regime) ||
      row.actual_level === null || !Number.isFinite(Number(row.actual_level)) ||
      !Number.isFinite(Date.parse(row.actual_time)) || Date.parse(row.actual_time) > now) { skipped++; continue; }
    let handled = false;
    for (let attempt = 0; attempt < 3 && !handled; attempt++) {
      const result = await db.from('forecast_learning_state').select('state,revision,enabled')
        .eq('bridge', row.bridge).eq('horizon_h', row.horizon_h).eq('regime', frozen.regime).maybeSingle();
      if (result.error) throw result.error;
      if (result.data?.enabled === false) { skipped++; handled = true; break; }
      const before = (result.data?.state ?? initialLearningState(frozen.regime)) as LearningState;
      const learned = learnFromOutcome(before, {
        candidates: frozen.candidates,
        actual_level: Number(row.actual_level), issued_level: Number(row.predicted_level),
        current_level: Number(row.current_level), issued_at: Date.parse(row.details.generated_at),
        actual_time: Date.parse(row.actual_time), issued_revision: Number(frozen.revision ?? 0),
      });
      if (!learned.metrics.accepted) { skipped++; handled = true; break; }
      const commit = await db.rpc('apply_forecast_learning_event', {
        p_forecast_id: row.id, p_regime: frozen.regime,
        p_expected_revision: Number(result.data?.revision ?? 0),
        p_before_state: before, p_after_state: learned.state,
        p_metrics: learned.metrics,
      });
      if (commit.error) throw commit.error;
      if (commit.data?.conflict) { conflicts++; continue; }
      if (commit.data?.applied) applied++; else skipped++;
      handled = true;
    }
  }
  return { applied, conflicts, skipped, queue_examined: pending.data?.length ?? 0 };
}

export async function learningStates(db: SupabaseClient) {
  const result = await db.from('forecast_learning_state').select('bridge,horizon_h,regime,state,revision,enabled,updated_at');
  if (result.error) throw result.error;
  return result.data ?? [];
}
