import { Group, Panel, useDefaultLayout } from 'react-resizable-panels'
import ActivityBar from './ActivityBar'
import Assets from './Assets/Assets'
import CanvasPanel from './CanvasPanel'
import DockArea from './DockArea'
import styles from './Editor.module.css'
import PropertiesPanel from './PropertiesPanel'
import SceneExplorer from './SceneExplorer'
import ScenePanel from './ScenePanel'
import StatusBar from './StatusBar'
import './global.css'

function Editor() {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'editor-layout',
    storage: localStorage,
  })

  return (
    <div className={styles.root}>
      <div className={styles.main}>
        <ActivityBar />
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
      <StatusBar />
    </div>
  )
}

export default Editor
