import { OFFICE_FURNITURE } from "../office/office-furniture"
import { LockIcon, PackageIcon, PlusIcon, Trash2Icon } from "./Icons"

interface Props {
  itemIds: string[]
  ownedItemIds: string[]
  selectedId: string | null
  onAdd: (itemId: string) => void
  onRemove: (instanceId: string) => void
}

export function OfficeInventoryBar({ itemIds, ownedItemIds, selectedId, onAdd, onRemove }: Props) {
  const items = OFFICE_FURNITURE.filter((item) => itemIds.includes(item.id))
  return <div className="office-inventory">
    <div className="office-inventory-title"><PackageIcon size={13} /><span>家具仓库</span></div>
    <div className="office-inventory-items">{items.map((item) => {
      const owned = ownedItemIds.includes(item.id)
      return <button key={item.id} type="button" disabled={!owned}
        className={`inventory-item inventory-${item.kind}`} onClick={() => onAdd(item.id)} title={owned ? `${item.name}：${item.description}` : "尚未拥有，请前往商店查看"}>
        <span className="inventory-swatch" /><span>{item.name}</span>{owned ? <PlusIcon size={11} /> : <LockIcon size={10} />}
      </button>
    })}</div>
    {selectedId && <button type="button" className="inventory-delete" onClick={() => onRemove(selectedId)} title="移除选中的家具"><Trash2Icon size={12} />移除</button>}
  </div>
}
