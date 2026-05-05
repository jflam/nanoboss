/**
 * A procedure panel entry rendered as a dedicated transcript block that is
 * always visible regardless of the tool-card toggle. Keyed by (rendererId,
 * key) for in-place replacement.
 */
export interface UiProcedurePanel {
  panelId: string;
  rendererId: string;
  payload: unknown;
  severity: "info" | "warn" | "error";
  dismissible: boolean;
  key?: string;
  runId?: string;
  turnId?: string;
  procedure?: string;
}

/**
 * A panel entry produced by a ui_panel event for any slot other than the
 * transcript (transcript-slot panels are materialized into UiTurn card
 * entries by the reducer so existing transcript rendering paths apply).
 * Keyed by (rendererId, key|undefined); lifetime controls when the reducer
 * evicts the entry.
 */
export interface UiPanel {
  rendererId: string;
  slot: string;
  key?: string;
  payload: unknown;
  lifetime: "turn" | "run" | "session";
  runId?: string;
  turnId?: string;
}
