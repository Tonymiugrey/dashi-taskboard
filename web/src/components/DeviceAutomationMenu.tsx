import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AUTOMATION_MODELS,
  getAutomationModel,
  withAutomationModel,
  type AutomationModel,
  type AutomationReasoningEffort,
} from "../../../shared/taskboard-automation-options.mjs";
import type { CodexTarget, CodexTargetAutomation } from "../types";
import { LinearIcon } from "./LinearIcon";

type AutomationDraft = Pick<
  CodexTargetAutomation,
  "enabledByUser" | "quotaAware" | "intervalMinutes" | "model" | "reasoningEffort" | "version"
>;

interface DeviceAutomationMenuProps {
  targets: CodexTarget[];
  loading: boolean;
  pending: boolean;
  error: string | null;
  onOpen: () => void;
  onChange: (target: CodexTarget, automation: AutomationDraft) => void;
}

const DEFAULT_AUTOMATION: AutomationDraft = {
  enabledByUser: false,
  quotaAware: false,
  intervalMinutes: 5,
  model: "gpt-5.5",
  reasoningEffort: "high",
  version: 0,
};

const EFFORT_LABELS: Record<AutomationReasoningEffort, string> = {
  low: "轻度",
  medium: "中",
  high: "高",
  xhigh: "极高 (xhigh)",
  max: "最高",
  ultra: "极高 (ultra)",
};

export function DeviceAutomationMenu({
  targets,
  loading,
  pending,
  error,
  onOpen,
  onChange,
}: DeviceAutomationMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<AutomationDraft>(DEFAULT_AUTOMATION);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });
  const selected = targets.find((target) => target.id === selectedId) ?? targets[0] ?? null;
  const onlineCount = targets.filter((target) => target.online).length;

  useEffect(() => {
    if (!selected) return;
    setSelectedId(selected.id);
    setDraft(selected.automation ?? DEFAULT_AUTOMATION);
  }, [selected?.id, selected?.automation]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(trigger.right - menu.width, window.innerWidth - menu.width - 8)),
      top: trigger.bottom + 8 + menu.height <= window.innerHeight
        ? trigger.bottom + 8
        : Math.max(8, trigger.top - menu.height - 8),
      ready: true,
    });
  }, [open, targets.length]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const closeViewport = () => setOpen(false);
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    window.addEventListener("resize", closeViewport);
    window.addEventListener("scroll", closeViewport, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeEscape);
      window.removeEventListener("resize", closeViewport);
      window.removeEventListener("scroll", closeViewport, true);
    };
  }, [open]);

  const stateLabel = useMemo(() => {
    if (loading && targets.length === 0) return "读取设备…";
    if (targets.length === 0) return "无设备";
    return `${onlineCount} 台在线`;
  }, [loading, onlineCount, targets.length]);

  const submitChange = (next: AutomationDraft) => {
    if (!selected || pending) return;
    setDraft(next);
    onChange(selected, next);
  };

  const menu = open ? createPortal(
    <div
      ref={menuRef}
      className="project-automation-menu device-automation-menu no-drag"
      role="dialog"
      aria-label="设备自动认领设置"
      style={{ left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}
    >
      <div className="project-automation-menu-heading">
        <strong>设备自动认领</strong>
        <span>{stateLabel}</span>
      </div>
      {targets.length === 0 ? (
        <p className="project-automation-note">当前项目没有已连接设备。</p>
      ) : (
        <div className="device-automation-layout">
          <div className="device-automation-targets" role="listbox" aria-label="选择设备">
            {targets.map((target) => (
              <button
                type="button"
                role="option"
                aria-selected={target.id === selected?.id}
                className={target.id === selected?.id ? "is-selected" : ""}
                key={target.id}
                onClick={() => setSelectedId(target.id)}
              >
                <i className={`codex-target-presence ${target.online ? "is-online" : ""}`} />
                <span><strong>{target.name}</strong><small>{target.online ? "在线" : "离线"}</small></span>
              </button>
            ))}
          </div>
          {selected && (
            <div className="device-automation-settings">
              <div className="project-automation-switch">
                <span>自动认领开关</span>
                <button
                  type="button"
                  className={`board-setting-switch${draft.enabledByUser ? " is-on" : ""}`}
                  role="switch"
                  aria-checked={draft.enabledByUser}
                  disabled={pending}
                  onClick={() => submitChange({ ...draft, enabledByUser: !draft.enabledByUser })}
                ><span aria-hidden="true" /></button>
              </div>
              <div className="project-automation-switch">
                <span>根据额度启用/关闭</span>
                <button
                  type="button"
                  className={`board-setting-switch${draft.quotaAware ? " is-on" : ""}`}
                  role="switch"
                  aria-checked={draft.quotaAware}
                  disabled={pending}
                  onClick={() => submitChange({ ...draft, quotaAware: !draft.quotaAware })}
                ><span aria-hidden="true" /></button>
              </div>
              {draft.quotaAware && <QuotaStatus automation={selected.automation} />}
              <label className="project-automation-field">
                <span>间隔</span>
                <select
                  value={draft.intervalMinutes}
                  disabled={pending}
                  onChange={(event) => submitChange({
                    ...draft,
                    intervalMinutes: Number(event.target.value) as AutomationDraft["intervalMinutes"],
                  })}
                >
                  {[5, 10, 15, 30, 60].map((minutes) => <option key={minutes} value={minutes}>{minutes} 分钟</option>)}
                </select>
              </label>
              <label className="project-automation-field">
                <span>模型</span>
                <select
                  value={draft.model}
                  disabled={pending}
                  onChange={(event) => submitChange(withAutomationModel(
                    draft,
                    event.target.value as AutomationModel,
                  ))}
                >
                  {AUTOMATION_MODELS.map((model) => (
                    <option key={model.slug} value={model.slug}>{model.label}</option>
                  ))}
                </select>
              </label>
              <label className="project-automation-field">
                <span>推理强度</span>
                <select
                  value={draft.reasoningEffort}
                  disabled={pending}
                  onChange={(event) => submitChange({
                    ...draft,
                    reasoningEffort: event.target.value as AutomationReasoningEffort,
                  })}
                >
                  {getAutomationModel(draft.model)?.efforts.map((effort) => (
                    <option key={effort} value={effort}>{EFFORT_LABELS[effort]}</option>
                  ))}
                </select>
              </label>
              {selected.automation && selected.automation.appliedVersion < selected.automation.version && (
                <p className="project-automation-note">配置已保存，设备上线后自动应用。</p>
              )}
            </div>
          )}
        </div>
      )}
      {error && <p className="project-automation-error" role="alert">{error}</p>}
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`project-automation-trigger no-drag ${onlineCount > 0 ? "is-active" : "is-paused"}`}
        aria-label={`设备自动认领，${stateLabel}`}
        aria-busy={loading || pending}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`设备自动认领 · ${stateLabel}`}
        onClick={() => {
          if (!open) {
            setPosition((current) => ({ ...current, ready: false }));
            onOpen();
          }
          setOpen((current) => !current);
        }}
      >
        <LinearIcon name="dashboard" />
        <span>{stateLabel}</span>
      </button>
      {menu}
    </>
  );
}

function QuotaStatus({ automation }: { automation: CodexTargetAutomation | null }) {
  const quota = automation?.quota;
  let label = "额度状态等待设备回报";
  if (quota?.state === "available") label = "当前额度可用";
  if (quota?.state === "blocked") {
    label = quota.resetsAt
      ? `额度已用尽，预计 ${new Intl.DateTimeFormat("zh-CN", {
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(quota.resetsAt * 1_000))} 恢复`
      : "额度已用尽";
  }
  if (quota?.state === "unknown") label = "额度状态未知";
  if (quota?.state === "unavailable") label = "当前账号无法读取额度";
  return (
    <div className={`project-automation-quota is-${quota?.state ?? "unknown"}`}>
      <span>{label}</span>
      {quota?.windows.map((window) => (
        <span className="device-automation-quota-window" key={window.label}>
          {window.label}剩余 {Math.round(window.remainingPercent)}%
        </span>
      ))}
    </div>
  );
}
