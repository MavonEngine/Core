import type { Activity } from './ActivityBar'
import { useState } from 'react'
import { Group, Panel, useDefaultLayout } from 'react-resizable-panels'
import ActivityBar from './ActivityBar'
import Assets from './Assets/Assets'
import CanvasPanel from './CanvasPanel'
import DockArea from './DockArea'
import styles from './Editor.module.css'
import PanelHeader from './PanelHeader'
import PropertiesPanel from './PropertiesPanel'
import SceneExplorer from './SceneExplorer'
import ScenePanel from './ScenePanel'
import ServerPanel from './Server/ServerPanel'
import StatusBar from './StatusBar'
import './global.css'

function Editor() {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'editor-layout',
    storage: localStorage,
  })
  const [activity, setActivity] = useState<Activity>('scene')

  return (
    <div className={styles.root}>
      <div className={styles.main}>
        <ActivityBar active={activity} onSelect={setActivity} />
        <div className={styles.workspace}>
          {/* Covers the editor rather than replacing it, so the viewport and the docks keep their state underneath */}
          {activity === 'server' && (
            <div className={`${styles.panel} ${styles.fullView}`}>
              <div className={styles.panelContent}>
                <PanelHeader title="Server" />
                <div className={styles.panelBody}>
                  <ServerPanel />
                </div>
              </div>
            </div>
          )}
          <Group defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged} orientation="horizontal" className={styles.editor}>
            <Panel id="left" collapsible minSize={140} defaultSize="14%" data-separator="active" className={styles.panel}>
              <DockArea
                location="left"
                builtins={[
                  { id: 'scene', title: 'Scene', element: <ScenePanel /> },
                  { id: 'explorer', title: 'Explorer', element: <SceneExplorer /> },
                ]}
              />
            </Panel>
            <Panel id="middle">
              <div className={styles.panelContent}>
                <Group orientation="vertical" className={styles.middleGroup}>
                  <CanvasPanel />
                  <Panel id="horizontal" className={styles.panel}>
                    <DockArea location="bottom" builtins={[{ id: 'assets', title: 'Assets', element: <Assets />, padded: false }]} />
                  </Panel>
                </Group>
              </div>
            </Panel>
            <Panel collapsible={true} id="right" minSize={180} defaultSize="19%" className={styles.panel}>
              <DockArea location="right" builtins={[{ id: 'properties', title: 'Properties', element: <PropertiesPanel /> }]} />
            </Panel>
          </Group>
        </div>
      </div>
      <StatusBar />
    </div>
  )
}

export default Editor
