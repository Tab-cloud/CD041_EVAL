import type { OfficeStoreProduct } from "../office/office-store"
import { HeartIcon, LockIcon, SparklesIcon } from "./Icons"

interface Props {
  product: OfficeStoreProduct
  owned: boolean
  selected: boolean
  wished: boolean
  onSelect: () => void
  onWishlist: () => void
}

export function OfficeStoreProductCard({ product, owned, selected, wished, onSelect, onWishlist }: Props) {
  return <article className={`office-product-card ${selected ? "selected" : ""}`} onClick={onSelect} style={{ "--product-accent": product.accent } as React.CSSProperties}>
    <div className={`office-product-art ${product.previewImage ? "has-image" : `product-art-${product.category}`}`} style={product.previewImage ? { backgroundImage: `url(${product.previewImage})` } : undefined}>
      <span className="office-product-badge">{product.badge ?? product.subtitle}</span>
      {!product.previewImage && <SparklesIcon size={28} />}
      <button type="button" className={wished ? "wished" : ""} onClick={(event) => { event.stopPropagation(); onWishlist() }} title={wished ? "取消收藏" : "加入收藏"}><HeartIcon size={12} /></button>
    </div>
    <div className="office-product-summary">
      <div><strong>{product.name}</strong><small>{product.subtitle}</small></div>
      <span className={owned ? "owned" : "price"}>{owned ? "已拥有" : product.price === 0 ? "免费" : `¥${product.price}`}</span>
    </div>
    {product.availability !== "free" && !owned && <div className="office-product-channel"><LockIcon size={9} />{product.availability === "coming-soon" ? "即将推出" : "购买渠道建设中"}</div>}
  </article>
}
