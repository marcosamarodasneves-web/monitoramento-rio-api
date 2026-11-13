import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { collectTick, getHistory, getSnapshot, registerAccess } from "./hydrology";
import { z } from "zod";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  hydrology: router({
    snapshot: publicProcedure.query(() => getSnapshot()),
    history: publicProcedure.input(z.object({ days: z.number().min(1).max(60).default(1) }).optional()).query(({ input }) => getHistory(input?.days ?? 1)),
    registerAccess: publicProcedure.input(z.object({ kind: z.enum(["app", "api"]).default("api") }).optional()).mutation(({ input }) => registerAccess(input?.kind ?? "api")),
    collectNow: protectedProcedure.mutation(() => collectTick()),
  }),
});

export type AppRouter = typeof appRouter;
