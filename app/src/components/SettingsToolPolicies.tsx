import type { SystemSettings, ToolPolicyMode, ToolPolicySettings } from "../system-settings"

interface Props {
  settings: SystemSettings
  update: <K extends keyof SystemSettings>(key: K, value: SystemSettings[K]) => void
}

const POLICY_GROUPS: Array<{ key: keyof ToolPolicySettings; title: string; description: string }> = [
  { key: "fileWrite", title: "文件写入", description: "创建、编辑文件及工程配置变更。" },
  { key: "terminal", title: "终端与编译", description: "执行命令、构建和外部进程。" },
  { key: "network", title: "网络访问", description: "公开网页搜索与内容读取。" },
  { key: "hardware", title: "硬件操作", description: "烧录、调试、串口和 USB 访问。" },
]

const POLICY_OPTIONS: Array<{ id: ToolPolicyMode; label: string }> = [
  { id: "allow", label: "允许" },
  { id: "ask", label: "询问" },
  { id: "deny", label: "禁止" },
]

export function SettingsToolPolicies({ settings, update }: Props) {
  const setPolicy = (key: keyof ToolPolicySettings, value: ToolPolicyMode) => {
    update("toolPolicies", { ...settings.toolPolicies, [key]: value })
  }
  const setPatterns = (key: "writePathAllowlist" | "commandAllowlist", value: string) => {
    update(key, value.split("\n").map((item) => item.trim()).filter(Boolean))
  }

  return <section className="settings-section">
    <div className="settings-section-title"><div><h2>工具权限</h2><p>每类能力独立授权并由子 Agent 继承；禁止项不可绕过，其余操作再按会话执行范围决定自动运行或询问。</p></div></div>
    <div className="settings-policy-list">
      {POLICY_GROUPS.map((group) => <div className="settings-policy-row" key={group.key}>
        <div><strong>{group.title}</strong><p>{group.description}</p></div>
        <div className="settings-segmented settings-policy-segmented">
          {POLICY_OPTIONS.map((option) => <button key={option.id} className={settings.toolPolicies[group.key] === option.id ? "active" : ""} onClick={() => setPolicy(group.key, option.id)}>{option.label}</button>)}
        </div>
      </div>)}
    </div>
    <div className="settings-pattern-grid">
      <label><strong>写入路径白名单</strong><span>每行一个 Glob，例如 <code>src/**</code>。路径会按真实工作区规范化，父级穿越与符号链接逃逸不会被授权；留空表示不额外限制。</span>
        <textarea value={settings.writePathAllowlist.join("\n")} onChange={(event) => setPatterns("writePathAllowlist", event.target.value)} placeholder="src/**&#10;docs/**" />
      </label>
      <label><strong>命令白名单</strong><span>每行一个单次命令 Glob，例如 <code>git diff*</code>。复合命令、管道、重定向与命令插值不会被白名单授权；留空表示不额外限制。</span>
        <textarea value={settings.commandAllowlist.join("\n")} onChange={(event) => setPatterns("commandAllowlist", event.target.value)} placeholder="git diff*&#10;npm test*" />
      </label>
    </div>
  </section>
}
