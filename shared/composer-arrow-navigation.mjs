export function resolveComposerArrowBoundary({
  key,
  selectionStart,
  selectionEnd,
  valueLength,
  altKey = false,
  ctrlKey = false,
  metaKey = false,
  shiftKey = false,
}) {
  if (
    (key !== "ArrowLeft" && key !== "ArrowRight")
    || altKey
    || ctrlKey
    || metaKey
    || shiftKey
    || !Number.isInteger(selectionStart)
    || !Number.isInteger(selectionEnd)
    || selectionStart !== selectionEnd
  ) return "pass";
  if (key === "ArrowLeft" && selectionStart === 0) return "previous";
  if (key === "ArrowRight" && selectionStart === valueLength) return "next";
  return "pass";
}
