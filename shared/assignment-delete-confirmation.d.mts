export type AssignmentBackspaceAction = "pass" | "arm" | "delete";

export function resolveAssignmentBackspace(options: {
  key: string;
  repeat?: boolean;
  targetId: string | null | undefined;
  armedTargetId: string | null;
  selectionStart: number | null;
  selectionEnd: number | null;
  adjacent: boolean;
}): AssignmentBackspaceAction;
