const TOKEN_PATTERN = /^eval_dt_[A-Za-z0-9_-]{40,80}$/

let communityToken = ""

export function setCommunityToken(value: unknown): void {
  if (value === "" || value == null) {
    communityToken = ""
    return
  }
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    throw new Error("社区账号凭据格式无效")
  }
  communityToken = value
}

export function clearCommunityToken(): void {
  communityToken = ""
}

export function hasCommunityToken(): boolean {
  return Boolean(communityToken)
}

export function readCommunityToken(): string {
  if (!communityToken) throw new Error("尚未绑定 Eval Web 账号")
  return communityToken
}
