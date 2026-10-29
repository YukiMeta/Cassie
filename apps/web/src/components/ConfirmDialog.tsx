import { useEffect } from "react";
import { answerConfirm, setConfirmMode, useAppState, type ConfirmMode } from "../store";

export const CONFIRM_MODES: [ConfirmMode, string][] = [
  ["paid", "只在花钱时确认"],
  ["always", "每次都确认"],
  ["auto", "不再确认"],
];

export function ConfirmDialog() {
  const state = useAppState();
  const req = state.confirm;
  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") answerConfirm(false);
      if (e.key === "Enter") answerConfirm(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [req]);
  if (!req) return null;
  return (
    <div className="confirm-scrim" onClick={() => answerConfirm(false)}>
      <div className="confirm-card" role="dialog" aria-modal="true" aria-label={req.title} onClick={(e) => e.stopPropagation()}>
        <h3>{req.title}</h3>
        <ul>{req.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
        {req.cost && <div className="confirm-cost">{req.cost}</div>}
        <footer>
          <select value={state.confirmMode} onChange={(e) => setConfirmMode(e.target.value as ConfirmMode)} aria-label="确认方式">
            {CONFIRM_MODES.map(([id, text]) => <option key={id} value={id}>{text}</option>)}
          </select>
          <button className="tool-btn" onClick={() => answerConfirm(false)}>取消</button>
          <button className="primary-btn" autoFocus onClick={() => answerConfirm(true)}>{req.action}</button>
        </footer>
      </div>
    </div>
  );
}
