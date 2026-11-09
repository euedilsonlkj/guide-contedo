import { and, eq, isNull } from "drizzle-orm";
import type { Executor } from "@/db/client";
import { alerts, events } from "@/db/schema";
import { logger } from "@/lib/logger";

export function recordEvent(db: Executor, type: string, payload: Record<string, unknown> = {}): void {
  db.insert(events).values({ type, payload }).run();
}

/** Opens an alert for the panel; an open alert with the same code is not repeated. */
export function raiseAlert(db: Executor, severity: "info" | "warning" | "critical", code: string, message: string): void {
  const open = db.select({ id: alerts.id }).from(alerts).where(and(eq(alerts.code, code), isNull(alerts.acknowledgedAt))).get();
  if (open) return;
  db.insert(alerts).values({ code, severity, message }).run();
  logger.warn("alert", { code, message });
}

export function acknowledgeAlert(db: Executor, id: number): void {
  db.update(alerts).set({ acknowledgedAt: new Date() }).where(eq(alerts.id, id)).run();
}
