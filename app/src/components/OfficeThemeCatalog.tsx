import type { OfficeEntitlements } from "../office/office-entitlements"
import { ownsOfficePack } from "../office/office-entitlements"
import { OFFICE_THEME_PACKS } from "../office/office-packs"
import { CheckIcon, LockIcon, PaintbrushIcon, XIcon } from "./Icons"

interface Props {
  activePackId: string
  previewPackId: string | null
  entitlements: OfficeEntitlements
  onSelect: (id: string) => void
  onPreview: (id: string) => void
  onClose: () => void
}

export function OfficeThemeCatalog({ activePackId, previewPackId, entitlements, onSelect, onPreview, onClose }: Props) {
  return <div className="office-theme-catalog">
    <header><div><PaintbrushIcon size={15} /><span><strong>办公室主题</strong><small>场景、灯光与限定家具组合包</small></span></div><button onClick={onClose} title="关闭主题列表"><XIcon size={13} /></button></header>
    <div className="office-theme-list">{OFFICE_THEME_PACKS.map((pack) => {
      const owned = ownsOfficePack(entitlements, pack.id)
      const active = previewPackId === pack.id || (!previewPackId && activePackId === pack.id)
      return <article key={pack.id} className={`${active ? "active" : ""} ${owned ? "owned" : "locked"}`}>
        <div className="office-theme-preview" style={{ backgroundImage: `url(${pack.assets.dark})` }}><span style={{ background: pack.accent }} /></div>
        <div className="office-theme-copy"><strong>{pack.name}</strong><small>{pack.subtitle}</small><p>{pack.description}</p></div>
        <button type="button" onClick={() => owned ? onSelect(pack.id) : onPreview(pack.id)}>
          {active ? <><CheckIcon size={11} />{owned ? "使用中" : "试玩中"}</> : owned ? "使用" : <><LockIcon size={10} />试玩</>}
        </button>
      </article>
    })}</div>
    <footer>权益仅保存在本机；后续可无缝接入订阅或兑换码服务。</footer>
  </div>
}
