import { Cloud, Laptop } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

export type Place = "local" | "cloud";

function Segment({ place, active, label, title, pill, onGo }: { place: Place; active: boolean; label: string; title: string; pill: boolean; onGo: (place: Place) => void }) {
  const Icon = place === "cloud" ? Cloud : Laptop;
  return <button type="button" data-place={place} aria-pressed={active} title={title} onClick={() => { if (!active) onGo(place); }}
    className={cn("flex h-full min-w-0 shrink items-center gap-1 rounded-full px-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
      active ? "bg-control font-semibold text-ink" : "text-ink-secondary hover:bg-control/60 hover:text-ink", !pill && "rounded-md")}
    style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
    <Icon size={14} aria-hidden="true" className="shrink-0" />
    <span className="min-w-0 truncate">{label}</span>
  </button>;
}

/** This computer | My Cloud, side by side: the one you are on is highlighted, the other is one click away. `power`: My
 * Cloud's "Always on" / "Sleeps when idle" line, kept in its tooltip and for screen readers. */
export function PlaceSwitch({ active, power = "", pill = false, onGo, menu }: {
  active: Place | null; power?: string; pill?: boolean; onGo: (place: Place) => void; menu?: React.ReactNode;
}) {
  const local = t("place.local");
  const cloud = t("cloudSetup.myCloud");
  const cloudTitle = power ? `${cloud} · ${power}` : cloud;
  return <div data-place-switch role="group" aria-label={t("sidebar.servers")}
    className={cn("flex h-7 min-w-0 max-w-full items-center gap-0.5 overflow-hidden text-[12.5px]", pill && "h-8 rounded-full bg-raised/50 p-0.5 text-[13px]")}>
    <Segment place="local" active={active === "local"} label={local} title={local} pill={pill} onGo={onGo} />
    <Segment place="cloud" active={active === "cloud"} label={cloud} title={cloudTitle} pill={pill} onGo={onGo} />
    {power && <span className="sr-only">{power}</span>}
    {menu}
  </div>;
}
