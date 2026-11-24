import { useEffect, useRef, useState, type PointerEvent } from "react";
import { createRoot } from "react-dom/client";
import type { PetApi } from "../src/pet-preload.js";
import type { PetAnimation, PetMember } from "../src/pet-state.js";
import "./pet.css";

const api = (window as Window & { teamhubPets?: PetApi }).teamhubPets!;
const assets: Record<PetAnimation, string> = {
  idle: "空闲", loading: "加载中", thinking: "推理中", executing: "代码执行",
  passed: "样本通过", failed: "样本失败", interrupted: "异常中断",
};

function Pets() {
  const [members, setMembers] = useState<PetMember[]>([]);
  const pointer = useRef<number | undefined>(undefined);
  useEffect(() => api.subscribe(state => setMembers(state.members)), []);
  const start = (event: PointerEvent, peer: string) => {
    if (!event.isPrimary || event.button !== 0 || pointer.current !== undefined) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointer.current = event.pointerId;
    api.pointer("start", peer);
  };
  const track = (event: PointerEvent, action: "move" | "end" | "cancel") => {
    if (event.pointerId !== pointer.current) return;
    if (action !== "move") pointer.current = undefined;
    api.pointer(action);
  };
  return <main className="pets" aria-label="TeamHub 桌宠">
    {members.map(({ peer, lead, animation, label, attention, reason }) =>
      <button key={peer} type="button" className={lead ? "pet lead" : "pet"} data-peer={peer}
        data-animation={animation} data-attention={attention}
        aria-label={`${peer} · ${label}`} title={reason ? `${peer} · ${label} · ${reason}` : peer}
        onPointerDown={event => start(event, peer)} onPointerMove={event => track(event, "move")}
        onPointerUp={event => track(event, "end")} onPointerCancel={event => track(event, "cancel")}
        onLostPointerCapture={event => track(event, "cancel")}>
        <span className="stage"><img src={`./桌宠/${assets[animation]}.gif`} alt="" draggable={false} /></span>
        <span className="caption"><strong>{peer}</strong><span>{label}</span></span>
      </button>)}
  </main>;
}

createRoot(document.getElementById("root")!).render(<Pets />);
