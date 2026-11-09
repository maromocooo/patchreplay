export interface AgentSnapshot {
  pane_id: string;
  agent_status: string;
}

const SETTLED = new Set(["idle", "done"]);

interface PaneState {
  status: string;
  /** The agent has been `working` since the last finished turn. */
  sawWorking: boolean;
  settledSince?: number;
}

/**
 * Turns a stream of agent-list snapshots into turn boundaries.
 * - start:  the agent entered `working` (first time this turn)
 * - finish: the agent worked, then stayed idle/done for `settleMs`
 * A blocked → idle transition with no work in between (e.g. a trust prompt) is not a turn.
 */
export class TurnTracker {
  private panes = new Map<string, PaneState>();
  constructor(private settleMs = 4000) {}

  /** Seed with the current state so panes already mid-turn are not mistaken for new turns. */
  seed(agents: AgentSnapshot[]) {
    for (const a of agents) this.panes.set(a.pane_id, { status: a.agent_status, sawWorking: a.agent_status === "working" });
  }

  update<T extends AgentSnapshot>(agents: T[], now: number): { starts: T[]; finishes: T[] } {
    const starts: T[] = [];
    const finishes: T[] = [];
    const seen = new Set<string>();
    for (const a of agents) {
      seen.add(a.pane_id);
      const st = this.panes.get(a.pane_id) ?? { status: a.agent_status, sawWorking: false };
      const status = a.agent_status;
      if (status === "working") {
        if (!st.sawWorking) starts.push(a);
        st.sawWorking = true;
        st.settledSince = undefined;
      } else if (SETTLED.has(status)) {
        if (st.sawWorking && st.settledSince === undefined) st.settledSince = now;
        if (st.sawWorking && st.settledSince !== undefined && now - st.settledSince >= this.settleMs) {
          finishes.push(a);
          st.sawWorking = false;
          st.settledSince = undefined;
        }
      } else {
        // blocked / unknown: the turn is still open
        st.settledSince = undefined;
      }
      st.status = status;
      this.panes.set(a.pane_id, st);
    }
    for (const id of this.panes.keys()) if (!seen.has(id)) this.panes.delete(id);
    return { starts, finishes };
  }
}
