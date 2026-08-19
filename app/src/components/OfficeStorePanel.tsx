import { useEffect, useMemo, useState } from "react"
import {
  loadOfficeEntitlements, saveOfficeEntitlements, subscribeOfficeEntitlements,
} from "../office/office-entitlements"
import {
  grantFreeOfficeProduct, loadOfficeWishlist, OFFICE_PRODUCT_CATEGORIES, OFFICE_STORE_PRODUCTS,
  ownsOfficeProduct, saveOfficeWishlist, setOfficeStorePreviewPack, type OfficeProductCategory,
} from "../office/office-store"
import {
  CheckCircleIcon, HeartIcon, LockIcon, PackageIcon, SearchIcon, ShoppingBagIcon, SparklesIcon,
} from "./Icons"
import { OfficeStoreProductCard } from "./OfficeStoreProductCard"
import "../office/office-store.css"

interface Props { onOpenOffice: () => void }
type Category = "all" | "owned" | OfficeProductCategory

export function OfficeStorePanel({ onOpenOffice }: Props) {
  const [category, setCategory] = useState<Category>("all")
  const [query, setQuery] = useState("")
  const [selectedId, setSelectedId] = useState("aurora-lab-theme")
  const [entitlements, setEntitlements] = useState(() => loadOfficeEntitlements())
  const [wishlist, setWishlist] = useState(() => loadOfficeWishlist())
  const [notice, setNotice] = useState("")

  useEffect(() => subscribeOfficeEntitlements(() => setEntitlements(loadOfficeEntitlements())), [])
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 2_500); return () => clearTimeout(timer) }, [notice])

  const products = useMemo(() => OFFICE_STORE_PRODUCTS.filter((product) => {
    if (category === "owned" && !ownsOfficeProduct(entitlements, product)) return false
    if (category !== "all" && category !== "owned" && product.category !== category) return false
    const text = `${product.name}${product.subtitle}${product.description}${product.includes.join("")}`.toLowerCase()
    return text.includes(query.trim().toLowerCase())
  }), [category, entitlements, query])
  const selected = OFFICE_STORE_PRODUCTS.find((product) => product.id === selectedId) ?? products[0] ?? OFFICE_STORE_PRODUCTS[0]
  const owned = ownsOfficeProduct(entitlements, selected)
  const wished = wishlist.includes(selected.id)

  const toggleWishlist = (id: string) => {
    const next = wishlist.includes(id) ? wishlist.filter((value) => value !== id) : [...wishlist, id]
    setWishlist(next); saveOfficeWishlist(next)
  }
  const tryInOffice = () => {
    if (!selected.previewPackId) { setNotice("该商品将在资产包完成后开放办公室试玩"); return }
    setOfficeStorePreviewPack(selected.previewPackId); onOpenOffice()
  }
  const claimFree = () => {
    const next = grantFreeOfficeProduct(entitlements, selected)
    saveOfficeEntitlements(next); setEntitlements(next); setNotice("商品已加入“我的资产”")
  }

  return <section className="office-store" aria-label="办公室商店">
    <header className="office-store-header">
      <div className="office-store-brand"><span><ShoppingBagIcon size={18} /></span><div><strong>Eval Office Store</strong><small>让开发过程像经营一间会成长的工作室</small></div></div>
      <label className="office-store-search"><SearchIcon size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索主题、家具或装修方案" /></label>
      <button type="button" className="office-store-wishlist" onClick={() => { setCategory("all"); setNotice(`已收藏 ${wishlist.length} 件商品`) }}><HeartIcon size={13} />收藏 <b>{wishlist.length}</b></button>
      <button type="button" className="office-store-redeem" onClick={() => setNotice("兑换码将在账号与权益服务接入后开放")}><PackageIcon size={13} />兑换码</button>
    </header>
    <nav className="office-store-categories" aria-label="商品分类">
      <span>商品分类</span>
      {OFFICE_PRODUCT_CATEGORIES.map((item) => <button key={item.id} type="button" className={category === item.id ? "active" : ""} onClick={() => setCategory(item.id)}>{item.label}{item.id === "owned" && <b>{entitlements.claimedProductIds.length}</b>}</button>)}
      <div className="office-store-local-rights"><LockIcon size={11} /><span><strong>本地权益模式</strong><small>后续可接账号与订阅服务</small></span></div>
    </nav>
    <main className="office-store-content">
      <div className="office-store-hero" style={{ backgroundImage: "linear-gradient(90deg, rgba(8,15,31,.95), rgba(8,15,31,.26)), url(/office/aurora-lab-dark.png)" }}>
        <span><SparklesIcon size={11} />本期精选</span><strong>极光电路实验室</strong><p>在青紫极光与暖色台灯之间，让每一次编译都有游戏里的仪式感。</p>
        <button type="button" onClick={() => { setSelectedId("aurora-lab-theme"); setOfficeStorePreviewPack("aurora-lab"); onOpenOffice() }}>立即试玩</button>
      </div>
      <div className="office-store-grid-title"><div><strong>{OFFICE_PRODUCT_CATEGORIES.find((item) => item.id === category)?.label}</strong><small>{products.length} 件本地商品设计</small></div></div>
      <div className="office-product-grid">{products.map((product) => <OfficeStoreProductCard key={product.id} product={product} owned={ownsOfficeProduct(entitlements, product)} selected={selected.id === product.id} wished={wishlist.includes(product.id)} onSelect={() => setSelectedId(product.id)} onWishlist={() => toggleWishlist(product.id)} />)}{products.length === 0 && <div className="office-store-empty">没有找到匹配的商品</div>}</div>
    </main>
    <aside className="office-product-detail" style={{ "--product-accent": selected.accent } as React.CSSProperties}>
      <div className={`office-product-detail-art ${selected.previewImage ? "has-image" : ""}`} style={selected.previewImage ? { backgroundImage: `url(${selected.previewImage})` } : undefined}><span>{selected.badge}</span>{!selected.previewImage && <SparklesIcon size={36} />}</div>
      <div className="office-product-detail-heading"><small>{selected.sku}</small><strong>{selected.name}</strong><p>{selected.description}</p></div>
      <div className="office-product-includes"><span>包含内容</span>{selected.includes.map((item) => <div key={item}><CheckCircleIcon size={11} />{item}</div>)}</div>
      <div className="office-product-detail-actions">
        <div><small>{owned ? "已加入本地资产库" : selected.price === 0 ? "永久免费" : "参考价格"}</small><strong>{owned ? "已拥有" : selected.price === 0 ? "免费" : `¥${selected.price}`}</strong></div>
        {owned ? <button type="button" className="primary" onClick={tryInOffice}>去使用</button>
          : selected.availability === "free" ? <button type="button" className="primary" onClick={claimFree}>免费领取</button>
          : <button type="button" className="primary pending" disabled><LockIcon size={11} />{selected.availability === "coming-soon" ? "即将推出" : "购买渠道建设中"}</button>}
        {selected.previewPackId && <button type="button" className="secondary" onClick={tryInOffice}>试玩</button>}
        <button type="button" className={`secondary wishlist ${wished ? "active" : ""}`} onClick={() => toggleWishlist(selected.id)}><HeartIcon size={11} />{wished ? "已收藏" : "收藏"}</button>
      </div>
      <footer>实际价格和永久权益以后端订单为准；当前不会创建虚假订单或扣款。</footer>
    </aside>
    {notice && <div className="office-store-notice">{notice}</div>}
  </section>
}
