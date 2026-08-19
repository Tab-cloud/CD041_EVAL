import { OFFICE_ACHIEVEMENTS, officeLevel, officeLevelProgress } from "../office/office-progression"
import type { OfficeProgression } from "../office/types"
import { CheckCircleIcon, SparklesIcon, TrophyIcon } from "./Icons"

export function OfficeProgressPanel({ progress }: { progress: OfficeProgression }) {
  const level = officeLevel(progress.xp)
  const levelProgress = officeLevelProgress(progress.xp)
  return <div className="office-progress-panel">
    <div className="office-progress-hero">
      <span><TrophyIcon size={20} /></span>
      <div><small>办公室等级</small><strong>Lv.{level} · 成长中的工作室</strong></div>
    </div>
    <div className="office-level-track"><i style={{ width: `${levelProgress.percent}%` }} /></div>
    <div className="office-level-copy"><span>{levelProgress.current} / {levelProgress.required} XP</span><b>{progress.researchPoints} 研发点</b></div>
    <div className="office-progress-stats"><div><strong>{progress.completedTasks}</strong><span>累计交付</span></div><div><strong>{progress.streakDays}</strong><span>连续开工天数</span></div></div>
    <div className="office-section-title"><SparklesIcon size={11} />成长收藏</div>
    <div className="office-achievement-list">{OFFICE_ACHIEVEMENTS.map((item) => {
      const unlocked = progress.unlockedAchievementIds.includes(item.id)
      const value = progress[item.metric]
      return <div key={item.id} className={unlocked ? "unlocked" : "locked"}>
        <span>{unlocked ? <CheckCircleIcon size={13} /> : <TrophyIcon size={13} />}</span>
        <div><strong>{item.name}</strong><small>{item.description}</small><i><b style={{ width: `${Math.min(100, value / item.threshold * 100)}%` }} /></i></div>
        <em>{Math.min(value, item.threshold)}/{item.threshold}</em>
      </div>
    })}</div>
    <div className="office-next-unlocks"><strong>等级奖励</strong><span className={level >= 2 ? "owned" : ""}>Lv.2 调试小黄鸭</span><span className={level >= 3 ? "owned" : ""}>Lv.3 提交里程碑板</span><span className={level >= 5 ? "owned" : ""}>Lv.5 版本发布杯</span></div>
  </div>
}
