export function resolveAssignmentBackspace({
  key,
  repeat = false,
  targetId,
  armedTargetId,
  selectionStart,
  selectionEnd,
  adjacent,
}) {
  if (
    key !== "Backspace"
    || !targetId
    || !adjacent
    || !Number.isInteger(selectionStart)
    || !Number.isInteger(selectionEnd)
    || selectionStart !== selectionEnd
  ) return "pass";
  if (armedTargetId === targetId && !repeat) return "delete";
  return "arm";
}
