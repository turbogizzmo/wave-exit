/**
 * Errors the user sees. Every one says what happened, why, and the one thing to do
 * next, in words an accountant uses. Technical detail goes in `detail`, which the
 * UI puts behind "Copy details for support".
 */
export type ProblemCode =
  | "not-a-wave-export"
  | "missing-file"
  | "missing-columns"
  | "damaged-file"
  | "unsupported-format"
  | "bad-value"
  | "empty-export"
  | "wave-key-rejected"
  | "wave-access-denied"
  | "wave-unavailable"
  | "wave-busy"
  | "wave-unexpected";

export class InputProblem extends Error {
  readonly code: ProblemCode;
  /** What happened and why, one or two sentences. */
  readonly explanation: string;
  /** The one thing to do next. */
  readonly nextStep: string;
  /** Technical detail for support. Never shown by default. */
  readonly detail?: string;

  constructor(code: ProblemCode, explanation: string, nextStep: string, detail?: string) {
    super(`${explanation} ${nextStep}`);
    this.name = "InputProblem";
    this.code = code;
    this.explanation = explanation;
    this.nextStep = nextStep;
    if (detail !== undefined) this.detail = detail;
  }
}
