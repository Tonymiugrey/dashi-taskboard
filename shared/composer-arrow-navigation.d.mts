export type ComposerArrowBoundaryAction = "pass" | "previous" | "next";

export function resolveComposerArrowBoundary(options: {
  key: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  valueLength: number;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}): ComposerArrowBoundaryAction;
