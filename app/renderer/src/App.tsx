import { useEffect, useState } from 'react'

interface AppInfo {
  name: string
  version: string
  dataDir: string
}

declare global {
  interface Window {
    mybuddy: {
      ping: () => Promise<string>
      getAppInfo: () => Promise<AppInfo>
    }
  }
}

export default function App() {
  const [ping, setPing] = useState<string>('...')
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    window.mybuddy.ping().then(setPing)
    window.mybuddy.getAppInfo().then(setInfo)
  }, [])

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">MyBuddy</div>
        <p className="hint">环境已就绪，阶段 1 骨架运行中</p>
      </aside>
      <main className="content">
        <h1>MyBuddy Agent</h1>
        <p>基于 pi SDK + Electron，对齐 MyBuddy 形态</p>
        <ul className="status-list">
          <li>IPC ping: <code>{ping}</code></li>
          {info && (
            <>
              <li>数据目录: <code>{info.dataDir}</code></li>
              <li>版本: <code>{info.version}</code></li>
            </>
          )}
        </ul>
      </main>
    </div>
  )
}
