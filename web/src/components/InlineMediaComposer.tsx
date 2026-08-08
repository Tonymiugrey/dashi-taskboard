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

export type InlineMediaSegment = InlineTextSegment | InlineImageSegment;
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
  onMention?: (target: CodexTarget) => void;
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

export function createInlineMediaSegments(text = ""): InlineMediaSegment[] {
  return [textSegment(text)];
}

export function inlineMediaImages(segments: InlineMediaSegment[]): PendingInlineImage[] {
  return segments.filter((segment): segment is PendingInlineImage => segment.type === "pending-image");
}

export function inlineMediaText(segments: InlineMediaSegment[]): string {
  return segments.flatMap((segment) => segment.type === "text" ? [segment.text] : []).join("");
}

export function serializeInlineMedia(segments: InlineMediaSegment[]): string {
  return segments.map((segment) => (
    segment.type === "text" ? segment.text : `\n\n${segment.token}\n\n`
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
    onMention,
  }, ref) {
    const textareas = useRef(new Map<string, HTMLTextAreaElement>());
    const pendingFocus = useRef<{ id: string; offset: number } | null>(null);
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
      if (!focus) return;
      const target = textareas.current.get(focus.id);
      if (!target) return;
      target.focus();
      target.setSelectionRange(focus.offset, focus.offset);
      pendingFocus.current = null;
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

    const filteredMentions = mentionMenu
      ? mentionOptions.filter((target) => target.name.toLocaleLowerCase().includes(
          mentionMenu.query.toLocaleLowerCase(),
        ))
      : [];

    function chooseMention(target: CodexTarget) {
      if (!mentionMenu) return;
      const segment = segments.find((candidate) => (
        candidate.id === mentionMenu.segmentId && candidate.type === "text"
      ));
      if (!segment || segment.type !== "text") return;
      const text = `${segment.text.slice(0, mentionMenu.start)}${segment.text.slice(mentionMenu.end)}`;
      const cursor = mentionMenu.start;
      pendingFocus.current = { id: segment.id, offset: cursor };
      onChange(segments.map((candidate) => candidate.id === segment.id ? { ...segment, text } : candidate));
      onMention?.(target);
      setMentionMenu(null);
    }

    function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
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
      onKeyDown?.(event);
    }

    function pasteImages(
      event: ClipboardEvent<HTMLTextAreaElement>,
      segment: InlineTextSegment,
    ) {
      const clipboardFiles = clipboardImages(event.clipboardData);
      if (clipboardFiles.length === 0) return;
      event.preventDefault();

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
      onChange(normalizeSegments(segments.filter((segment) => segment.id !== id)));
    }

    const isEmpty = segments.every((segment) => (
      segment.type === "text" ? segment.text.length === 0 : false
    ));

    return (
      <div className={`inline-media-composer ${className}`.trim()} aria-label={ariaLabel}>
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
              onKeyDown={handleKeyDown}
              onBlur={(event) => {
                if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) {
                  setMentionMenu(null);
                }
              }}
            />
          ) : (
            <PendingImageBlock
              key={segment.id}
              segment={segment}
              disabled={disabled}
              onRemove={() => removeImage(segment.id)}
            />
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
