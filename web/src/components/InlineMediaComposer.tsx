import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type KeyboardEventHandler,
} from "react";
import type { Attachment } from "../types";
import type { CodexTarget } from "../types";
import { attachmentContentUrl } from "../api";
import { resolveAssignmentBackspace } from "../../../shared/assignment-delete-confirmation.mjs";
import { resolveComposerArrowBoundary } from "../../../shared/composer-arrow-navigation.mjs";
import { clipboardImages, fileKey, MAX_ATTACHMENT_SIZE } from "./PendingAttachments";
import { LinearIcon } from "./LinearIcon";

interface InlineTextSegment {
  id: string;
  type: "text";
  text: string;
}

interface InlineImageSegment {
  id: string;
  type: "pending-image";
  token: string;
  file: File;
}

export interface InlineAssignmentSegment {
  id: string;
  type: "codex-assignment";
  target: CodexTarget;
  instruction: string;
}

export type InlineMediaSegment = InlineTextSegment | InlineImageSegment | InlineAssignmentSegment;
export type PendingInlineImage = InlineImageSegment;

export interface InlineMediaComposerHandle {
  focus: () => void;
  openMentionPicker: () => void;
}

interface InlineMediaComposerProps {
  segments: InlineMediaSegment[];
  placeholder: string;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
  onChange: (segments: InlineMediaSegment[]) => void;
  onError: (message: string | null) => void;
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
  mentionOptions?: CodexTarget[];
  armedAssignmentId?: string | null;
  onArmedAssignmentChange?: (targetId: string | null) => void;
}

let segmentSequence = 0;

function segmentId(prefix: string): string {
  segmentSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${segmentSequence.toString(36)}`;
}

function textSegment(text = ""): InlineTextSegment {
  return { id: segmentId("text"), type: "text", text };
}

function imageSegment(file: File): InlineImageSegment {
  const id = segmentId("image");
  return {
    id,
    type: "pending-image",
    token: `<!--taskboard-inline-image:${id}-->`,
    file,
  };
}

function assignmentSegment(target: CodexTarget): InlineAssignmentSegment {
  return {
    id: segmentId("assignment"),
    type: "codex-assignment",
    target,
    instruction: "",
  };
}

export function createInlineMediaSegments(text = ""): InlineMediaSegment[] {
  return [textSegment(text)];
}

export function inlineMediaImages(segments: InlineMediaSegment[]): PendingInlineImage[] {
  return segments.filter((segment): segment is PendingInlineImage => segment.type === "pending-image");
}

export function inlineMediaAssignments(segments: InlineMediaSegment[]): InlineAssignmentSegment[] {
  return segments.filter((segment): segment is InlineAssignmentSegment => (
    segment.type === "codex-assignment"
  ));
}

export function inlineMediaText(segments: InlineMediaSegment[]): string {
  return segments.flatMap((segment) => segment.type === "text" ? [segment.text] : []).join("");
}

export function serializeInlineMedia(segments: InlineMediaSegment[]): string {
  return segments.map((segment) => (
    segment.type === "text"
      ? segment.text
      : segment.type === "pending-image" ? `\n\n${segment.token}\n\n` : ""
  )).join("");
}

export function resolveInlineMediaMarkdown(
  value: string,
  images: PendingInlineImage[],
  attachments: Attachment[],
): string {
  return images.reduce((markdown, image, index) => {
    const attachment = attachments[index];
    if (!attachment) return markdown;
    const alt = image.file.name.replace(/[\\[\]]/g, "\\$&");
    return markdown.replace(
      image.token,
      `![${alt}](${attachmentContentUrl(attachment)})`,
    );
  }, value);
}

function normalizeSegments(segments: InlineMediaSegment[]): InlineMediaSegment[] {
  const normalized: InlineMediaSegment[] = [];
  for (const segment of segments) {
    const previous = normalized.at(-1);
    if (segment.type === "text" && previous?.type === "text") {
      normalized[normalized.length - 1] = {
        ...previous,
        text: previous.text + segment.text,
      };
    } else {
      normalized.push(segment);
    }
  }
  if (normalized.length === 0) return [textSegment()];
  if (normalized[0].type !== "text") normalized.unshift(textSegment());
  if (normalized.at(-1)?.type !== "text") normalized.push(textSegment());
  return normalized;
}

function resizeTextarea(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "0px";
  element.style.height = `${element.scrollHeight}px`;
}

function PendingImageBlock({
  segment,
  disabled,
  onRemove,
}: {
  segment: PendingInlineImage;
  disabled: boolean;
  onRemove: () => void;
}) {
  const [previewUrl, setPreviewUrl] = useState("");

  useLayoutEffect(() => {
    const url = URL.createObjectURL(segment.file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [segment.file]);

  return (
    <figure className="inline-media-image">
      {previewUrl && <img src={previewUrl} alt={segment.file.name} />}
      <button
        type="button"
        disabled={disabled}
        aria-label={`移除 ${segment.file.name}`}
        onClick={onRemove}
      >
        <LinearIcon name="close" />
      </button>
    </figure>
  );
}

export const InlineMediaComposer = forwardRef<InlineMediaComposerHandle, InlineMediaComposerProps>(
  function InlineMediaComposer({
    segments,
    placeholder,
    ariaLabel,
    disabled = false,
    className = "",
    onChange,
    onError,
    onKeyDown,
    mentionOptions = [],
    armedAssignmentId = null,
    onArmedAssignmentChange,
  }, ref) {
    const textareas = useRef(new Map<string, HTMLTextAreaElement>());
    const assignmentInputs = useRef(new Map<string, HTMLInputElement>());
    const pendingFocus = useRef<{ id: string; offset: number } | null>(null);
    const pendingAssignmentFocus = useRef<string | null>(null);
    const [mentionMenu, setMentionMenu] = useState<{
      segmentId: string;
      start: number;
      end: number;
      query: string;
      selectedIndex: number;
    } | null>(null);

    useLayoutEffect(() => {
      for (const element of textareas.current.values()) resizeTextarea(element);
      const focus = pendingFocus.current;
      if (focus) {
        const target = textareas.current.get(focus.id);
        if (target) {
          target.focus();
          target.setSelectionRange(focus.offset, focus.offset);
          pendingFocus.current = null;
        }
      }
      const assignmentFocus = pendingAssignmentFocus.current;
      if (!assignmentFocus) return;
      assignmentInputs.current.get(assignmentFocus)?.focus();
      pendingAssignmentFocus.current = null;
    }, [segments]);

    useImperativeHandle(ref, () => ({
      focus() {
        const firstText = segments.find((segment) => segment.type === "text");
        if (firstText) textareas.current.get(firstText.id)?.focus();
      },
      openMentionPicker,
    }), [mentionOptions, segments]);

    function openMentionPicker() {
      if (mentionOptions.length === 0) return;
      const focusedEntry = [...textareas.current.entries()].find(([, element]) => (
        element === document.activeElement
      ));
      const segment = focusedEntry
        ? segments.find((candidate) => candidate.id === focusedEntry[0])
        : [...segments].reverse().find((candidate) => candidate.type === "text");
      if (!segment || segment.type !== "text") return;
      const element = textareas.current.get(segment.id);
      const start = element === document.activeElement
        ? element.selectionStart
        : segment.text.length;
      const end = element === document.activeElement ? element.selectionEnd : start;
      const prefix = start > 0 && !/\s/.test(segment.text[start - 1]) ? " @" : "@";
      const nextText = `${segment.text.slice(0, start)}${prefix}${segment.text.slice(end)}`;
      const mentionStart = start + prefix.length - 1;
      const cursor = start + prefix.length;
      pendingFocus.current = { id: segment.id, offset: cursor };
      onChange(segments.map((candidate) => candidate.id === segment.id
        ? { ...segment, text: nextText }
        : candidate));
      setMentionMenu({
        segmentId: segment.id,
        start: mentionStart,
        end: cursor,
        query: "",
        selectedIndex: 0,
      });
    }

    function changeText(id: string, text: string, cursor: number) {
      onArmedAssignmentChange?.(null);
      onChange(segments.map((segment) => (
        segment.id === id && segment.type === "text" ? { ...segment, text } : segment
      )));
      const before = text.slice(0, cursor);
      const match = before.match(/(?:^|\s)(@([^\s@]{0,120}))$/);
      if (!match || mentionOptions.length === 0) {
        setMentionMenu(null);
        return;
      }
      setMentionMenu({
        segmentId: id,
        start: cursor - match[1].length,
        end: cursor,
        query: match[2],
        selectedIndex: 0,
      });
    }

    const assignedTargetIds = new Set(inlineMediaAssignments(segments).map(
      (assignment) => assignment.target.id,
    ));
    const filteredMentions = mentionMenu
      ? mentionOptions.filter((target) => (
          !assignedTargetIds.has(target.id)
          && target.name.toLocaleLowerCase().includes(mentionMenu.query.toLocaleLowerCase())
        ))
      : [];

    function chooseMention(target: CodexTarget) {
      if (!mentionMenu) return;
      const segment = segments.find((candidate) => (
        candidate.id === mentionMenu.segmentId && candidate.type === "text"
      ));
      if (!segment || segment.type !== "text") return;
      const before = { ...segment, text: segment.text.slice(0, mentionMenu.start) };
      const assignment = assignmentSegment(target);
      const after = textSegment(segment.text.slice(mentionMenu.end));
      pendingAssignmentFocus.current = assignment.id;
      onChange(segments.flatMap((candidate) => (
        candidate.id === segment.id ? [before, assignment, after] : [candidate]
      )));
      onArmedAssignmentChange?.(null);
      setMentionMenu(null);
    }

    function removeAssignment(id: string) {
      const index = segments.findIndex((segment) => segment.id === id);
      const before = segments[index - 1];
      const after = segments[index + 1];
      if (before?.type === "text" && after?.type === "text") {
        const offset = before.text.length;
        pendingFocus.current = { id: before.id, offset };
        onChange(segments.filter((_, segmentIndex) => (
          segmentIndex !== index && segmentIndex !== index + 1
        )).map((segment) => segment.id === before.id
          ? { ...before, text: before.text + after.text }
          : segment));
      } else {
        onChange(normalizeSegments(segments.filter((segment) => segment.id !== id)));
      }
      onArmedAssignmentChange?.(null);
    }

    function applyAssignmentBackspace(
      event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>,
      targetId: string | null | undefined,
      assignmentId: string | null | undefined,
      adjacent: boolean,
    ): boolean {
      const action = resolveAssignmentBackspace({
        key: event.key,
        repeat: event.repeat,
        targetId,
        armedTargetId: armedAssignmentId,
        selectionStart: event.currentTarget.selectionStart,
        selectionEnd: event.currentTarget.selectionEnd,
        adjacent,
      });
      if (action === "pass") return false;
      event.preventDefault();
      if (action === "delete" && assignmentId) removeAssignment(assignmentId);
      else if (targetId) onArmedAssignmentChange?.(targetId);
      return true;
    }

    function moveAcrossSegmentBoundary(
      event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>,
      segmentIndex: number,
    ): boolean {
      const action = resolveComposerArrowBoundary({
        key: event.key,
        selectionStart: event.currentTarget.selectionStart,
        selectionEnd: event.currentTarget.selectionEnd,
        valueLength: event.currentTarget.value.length,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      });
      if (action === "pass") return false;
      const destination = segments[segmentIndex + (action === "previous" ? -1 : 1)];
      const element = destination?.type === "text"
        ? textareas.current.get(destination.id)
        : destination?.type === "codex-assignment"
          ? assignmentInputs.current.get(destination.id)
          : null;
      if (!element) return false;
      event.preventDefault();
      onArmedAssignmentChange?.(null);
      element.focus();
      const offset = action === "previous" ? element.value.length : 0;
      element.setSelectionRange(offset, offset);
      return true;
    }

    function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>, segmentIndex: number) {
      if (mentionMenu && filteredMentions.length > 0) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const direction = event.key === "ArrowDown" ? 1 : -1;
          setMentionMenu((current) => current ? {
            ...current,
            selectedIndex: (
              current.selectedIndex + direction + filteredMentions.length
            ) % filteredMentions.length,
          } : null);
          return;
        }
        if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
          event.preventDefault();
          chooseMention(filteredMentions[mentionMenu.selectedIndex] ?? filteredMentions[0]);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setMentionMenu(null);
          return;
        }
      }
      const previous = segments[segmentIndex - 1];
      if (
        previous?.type === "codex-assignment"
        && applyAssignmentBackspace(
          event,
          previous.target.id,
          previous.id,
          event.currentTarget.selectionStart === 0,
        )
      ) return;
      if (moveAcrossSegmentBoundary(event, segmentIndex)) return;
      if (armedAssignmentId) onArmedAssignmentChange?.(null);
      onKeyDown?.(event);
    }

    function handleAssignmentKeyDown(
      event: KeyboardEvent<HTMLInputElement>,
      assignment: InlineAssignmentSegment,
      segmentIndex: number,
    ) {
      if (applyAssignmentBackspace(
        event,
        assignment.target.id,
        assignment.id,
        assignment.instruction.length === 0 && event.currentTarget.selectionStart === 0,
      )) return;
      if (moveAcrossSegmentBoundary(event, segmentIndex)) return;
      if (armedAssignmentId) onArmedAssignmentChange?.(null);
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        onKeyDown?.(event as unknown as KeyboardEvent<HTMLTextAreaElement>);
      }
    }

    function pasteImages(
      event: ClipboardEvent<HTMLTextAreaElement>,
      segment: InlineTextSegment,
    ) {
      const clipboardFiles = clipboardImages(event.clipboardData);
      if (clipboardFiles.length === 0) return;
      event.preventDefault();
      onArmedAssignmentChange?.(null);

      const oversized = clipboardFiles.find((file) => file.size > MAX_ATTACHMENT_SIZE);
      if (oversized) {
        onError(`“${oversized.name}” 超过 25 MB，无法上传。`);
        return;
      }

      const existing = new Set(inlineMediaImages(segments).map((image) => fileKey(image.file)));
      const images = clipboardFiles.filter((file) => {
        const key = fileKey(file);
        if (existing.has(key)) return false;
        existing.add(key);
        return true;
      });
      if (images.length === 0) return;
      onError(null);

      const textarea = event.currentTarget;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const before = { ...segment, text: segment.text.slice(0, start) };
      const after = textSegment(segment.text.slice(end));
      const insertion = images.map(imageSegment);
      const next = segments.flatMap((candidate) => (
        candidate.id === segment.id ? [before, ...insertion, after] : [candidate]
      ));
      pendingFocus.current = { id: after.id, offset: 0 };
      onChange(next);
    }

    function removeImage(id: string) {
      onArmedAssignmentChange?.(null);
      onChange(normalizeSegments(segments.filter((segment) => segment.id !== id)));
    }

    const isEmpty = segments.every((segment) => (
      segment.type === "text" ? segment.text.length === 0 : false
    ));
    const hasAssignments = segments.some((segment) => segment.type === "codex-assignment");

    return (
      <div
        className={`inline-media-composer${hasAssignments ? " has-inline-assignments" : ""} ${className}`.trim()}
        aria-label={ariaLabel}
      >
        {segments.map((segment, index) => (
          segment.type === "text" ? (
            <textarea
              key={segment.id}
              ref={(element) => {
                if (element) textareas.current.set(segment.id, element);
                else textareas.current.delete(segment.id);
              }}
              value={segment.text}
              rows={1}
              disabled={disabled}
              data-mention-menu-open={mentionMenu?.segmentId === segment.id ? "true" : undefined}
              aria-label={index === 0 ? ariaLabel : `${ariaLabel}续写`}
              placeholder={isEmpty && index === 0 ? placeholder : undefined}
              onChange={(event) => {
                changeText(segment.id, event.target.value, event.target.selectionStart);
                resizeTextarea(event.currentTarget);
              }}
              onPaste={(event) => pasteImages(event, segment)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              onSelect={() => {
                if (armedAssignmentId) onArmedAssignmentChange?.(null);
              }}
              onBlur={(event) => {
                if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) {
                  setMentionMenu(null);
                }
              }}
            />
          ) : segment.type === "pending-image" ? (
            <PendingImageBlock
              key={segment.id}
              segment={segment}
              disabled={disabled}
              onRemove={() => removeImage(segment.id)}
            />
          ) : (
            <label
              key={segment.id}
              data-assignment-id={segment.target.id}
              className={`inline-codex-assignment${
                armedAssignmentId === segment.target.id ? " is-delete-confirming" : ""
              }`}
            >
              <span className="inline-codex-assignment-target">
                <i className={`codex-target-presence ${segment.target.online ? "is-online" : ""}`} />
                @{segment.target.name}
              </span>
              <span className="inline-codex-assignment-divider" aria-hidden="true">|</span>
              <input
                ref={(element) => {
                  if (element) assignmentInputs.current.set(segment.id, element);
                  else assignmentInputs.current.delete(segment.id);
                }}
                type="text"
                disabled={disabled}
                value={segment.instruction}
                placeholder={armedAssignmentId === segment.target.id
                  ? "再次退格删除"
                  : "输入设备任务…"}
                aria-label={`输入给 ${segment.target.name} 的任务`}
                onChange={(event) => {
                  onArmedAssignmentChange?.(null);
                  onChange(segments.map((candidate) => candidate.id === segment.id
                    ? { ...segment, instruction: event.target.value }
                    : candidate));
                }}
                onKeyDown={(event) => handleAssignmentKeyDown(event, segment, index)}
                onSelect={() => {
                  if (armedAssignmentId) onArmedAssignmentChange?.(null);
                }}
              />
              <button
                type="button"
                disabled={disabled}
                aria-label={`移除 ${segment.target.name} 的任务`}
                onClick={() => removeAssignment(segment.id)}
              >
                <LinearIcon name="close" />
              </button>
            </label>
          )
        ))}
        {mentionMenu && filteredMentions.length > 0 && (
          <div className="codex-mention-menu" role="listbox" aria-label="选择 Codex 目标">
            <div className="codex-mention-menu-title">分配设备任务</div>
            {filteredMentions.map((target, index) => (
              <button
                type="button"
                role="option"
                aria-selected={index === mentionMenu.selectedIndex}
                className={index === mentionMenu.selectedIndex ? "is-selected" : ""}
                key={target.id}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => chooseMention(target)}
              >
                <span className={`codex-target-presence ${target.online ? "is-online" : ""}`} />
                <strong>{target.name}</strong>
                <span>{target.online ? "在线，立即处理" : "离线，上线后处理"}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  },
);
