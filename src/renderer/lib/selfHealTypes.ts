/**
 * Easel — self-heal phase state shape (issue #31).
 *
 * Shared between the store (which holds it as `selfHealPhase`) and the pure
 * correlation helpers in {@link ./selfHealLoop}. Kept in its own module so both
 * can import it without the helper depending on the Zustand store.
 *
 * Issue #32 RENDERS this; #31 only wires the state + correlation.
 */

/**
 * The current self-heal lifecycle phase for a turn, or `null` when idle. The
 * two phases mirror the `verifying` / `retrying` {@link AgentEvent} variants:
 *  - `verifying`: the vision judge is running for the attempt that just settled.
 *  - `retrying`: a `verify:fail` triggered a bounded resubmission; `attempt`
 *    is the upcoming attempt number and `rationale` is the judge's feedback.
 */
export type SelfHealPhase =
  | { requestId: string; phase: 'verifying' }
  | { requestId: string; phase: 'retrying'; attempt: number; rationale: string };
