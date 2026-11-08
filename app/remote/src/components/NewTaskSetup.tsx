import { LayoutGrid, Briefcase, Check, ChevronDown, ChevronLeft, ChevronRight, Code2, Folder, Tag, X } from 'lucide-react'
import { useRemoteStore } from '../store/remoteStore'
import { spaceBreadcrumb } from '../lib/spaceGroups'

export function NewTaskSetupChips() {
  const s = useRemoteStore()
  const mode = s.bootstrap?.taskModes?.find(mode => mode.id === s.selectedWelcomeMode)
  const tag = mode?.tags.find(tag => tag.id === s.selectedModePresetId)
  const space = s.bootstrap?.spaces.find(space => space.id === s.selectedSpaceId)
  const project = s.bootstrap?.projects.find(project => project.id === s.selectedProjectId)
  return <div className="task-setup-chips">
    <button className="task-setup-chip task-setup-location" aria-label="选择新任务位置" disabled={s.creating} onClick={() => s.setTaskSetupSection('location')}>
      <Folder size={14} /><span>{space?.name ?? (s.selectedSpaceId ? '空间不可用' : '独立任务')}{project ? ` · ${project.name}` : ''}</span><ChevronDown size={12} />
    </button>
    <button className={`task-setup-chip ${mode ? 'chosen' : ''}`} aria-label="新任务模式" disabled={s.creating} onClick={() => s.setTaskSetupSection('mode')}>
      {mode?.id === 'general' ? <LayoutGrid size={14} /> : mode?.id === 'coding' ? <Code2 size={14} /> : <Briefcase size={14} />}<span>{mode?.label ?? '选择模式'}</span>
    </button>
    <button className={`task-setup-chip ${tag ? 'chosen' : ''}`} aria-label="新任务 Tag" disabled={s.creating} onClick={() => s.setTaskSetupSection(mode ? 'tag' : 'mode')}>
      <Tag size={13} /><span>{tag?.label ?? '选择 Tag'}</span>
    </button>
  </div>
}

export function NewTaskSetupSheet() {
  const s = useRemoteStore()
  const section = s.taskSetupSection
  const open = !!section && !s.activeTaskId
  const modes = s.bootstrap?.taskModes ?? []
  const mode = modes.find(mode => mode.id === s.selectedWelcomeMode)
  const spaces = (s.bootstrap?.spaces ?? []).filter(space => !space.archived && !space.effectiveArchived)
  const projects = (s.bootstrap?.projects ?? []).filter(project => !project.archived)
  const title = section === 'location' ? '任务位置' : section === 'project' ? '关联项目' : section === 'mode' ? '选择模式' : '选择 Tag'
  const close = () => s.setTaskSetupSection(null)
  return <>
    <div className={`claude-sheet-backdrop ${open ? 'open' : ''}`} onClick={close} />
    <section className={`claude-sheet task-setup-sheet ${open ? 'open' : ''}`} role="dialog" aria-label={title} aria-modal={open || undefined} aria-hidden={!open} inert={!open}>
      <div className="claude-sheet-grabber" />
      <header className="task-setup-heading">
        {(section === 'tag' || section === 'project') && <button className="setup-icon-button" aria-label="返回上一级" onClick={() => s.setTaskSetupSection(section === 'tag' ? 'mode' : 'location')}><ChevronLeft size={20} /></button>}
        <div><h2>{title}</h2><p>{section === 'location' ? '任务会在所选文件夹中工作' : section === 'project' ? '关联后使用该项目的上下文与记忆' : section === 'mode' ? '先选工作方式，再选适合的 Tag' : `${mode?.label ?? '任务'} · 选择本次任务的用途`}</p></div>
        <button className="setup-icon-button" aria-label="关闭任务设置" onClick={close}><X size={20} /></button>
      </header>
      <div className="task-setup-options">
        {section === 'location' && <>
          <button className="setup-choice" aria-label="位置：独立任务" aria-pressed={!s.selectedSpaceId} onClick={() => { s.setSelectedSpaceId(null); close() }}><Folder size={20} /><span><strong>独立任务</strong><small>不加入空间文件夹</small></span>{!s.selectedSpaceId && <Check size={18} />}</button>
          {spaces.map(space => <button key={space.id} className="setup-choice" aria-label={`位置：${spaceBreadcrumb(spaces, space.id)}`} aria-pressed={s.selectedSpaceId === space.id} disabled={space.pathMissing}
            onClick={() => { s.setSelectedSpaceId(space.id); close() }}><Folder size={20} /><span><strong>{space.name}</strong><small>{space.pathMissing ? '文件夹不可用' : space.parentId ? spaceBreadcrumb(spaces, space.parentId) : '空间文件夹'}</small></span>{s.selectedSpaceId === space.id && <Check size={18} />}</button>)}
        </>}
        {section === 'mode' && modes.map(option => {
          const Icon = option.id === 'general' ? LayoutGrid : option.id === 'coding' ? Code2 : Briefcase
          return <button key={option.id} className="setup-choice" aria-label={`模式：${option.label}`} aria-pressed={mode?.id === option.id} onClick={() => { if (s.selectedWelcomeMode !== option.id) s.setSelectedWelcomeMode(option.id); s.setTaskSetupSection('tag') }}>
            <Icon size={22} /><span><strong>{option.label}</strong><small>{option.id === 'general' ? '通用任务，按需执行与交付' : option.id === 'coding' ? '开发、调试与代码维护' : '文档、分析与日常事务'}</small></span>{mode?.id === option.id ? <Check size={18} /> : <ChevronRight size={17} />}
          </button>
        })}
        {section === 'mode' && !modes.length && <p className="setup-empty">电脑端尚未提供模式，请更新电脑端并刷新连接。</p>}
        {section === 'tag' && <div className="setup-tag-grid">{mode?.tags.map(tag => <button key={tag.id} className="setup-tag" aria-label={`Tag：${tag.label}`} aria-pressed={s.selectedModePresetId === tag.id}
          onClick={() => { s.setSelectedModePresetId(tag.id); close() }}><strong>{tag.label}</strong>{s.selectedModePresetId === tag.id && <Check size={16} />}{tag.description && <small>{tag.description}</small>}</button>)}</div>}
        {section === 'tag' && !mode?.tags.length && <p className="setup-empty">此模式暂无 Tag，请先在电脑端配置。</p>}
        {section === 'project' && <>
          <button className="setup-choice" aria-label="项目：不加入项目" aria-pressed={!s.selectedProjectId} onClick={() => { s.setSelectedProjectId(null); s.setTaskSetupSection('location') }}><Briefcase size={20} /><span><strong>不加入项目</strong></span>{!s.selectedProjectId && <Check size={18} />}</button>
          {projects.map(project => <button key={project.id} className="setup-choice" aria-label={`项目：${project.name}`} aria-pressed={s.selectedProjectId === project.id}
            onClick={() => { s.setSelectedProjectId(project.id); s.setTaskSetupSection('location') }}><Briefcase size={20} /><span><strong>{project.name}</strong>{project.description && <small>{project.description}</small>}</span>{s.selectedProjectId === project.id && <Check size={18} />}</button>)}
        </>}
      </div>
      {section === 'location' && <button className="setup-project-link" aria-label="选择关联项目" onClick={() => s.setTaskSetupSection('project')}><Briefcase size={16} /><span>关联项目</span><strong>{projects.find(project => project.id === s.selectedProjectId)?.name ?? '未关联'}</strong><ChevronRight size={16} /></button>}
    </section>
  </>
}
