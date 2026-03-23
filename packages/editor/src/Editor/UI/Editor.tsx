import { Group, Panel, useDefaultLayout } from 'react-resizable-panels'
import ActivityBar from './ActivityBar'
import Assets from './Assets/Assets'
import CanvasPanel from './CanvasPanel'
import styles from './Editor.module.css'
import PanelHeader from './PanelHeader'
import PropertiesPanel from './PropertiesPanel'
import SceneExplorer from './SceneExplorer'
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
        <Group defaultLayout={defaultLayout} onLayoutChange={onLayoutChanged} orientation="horizontal" className={styles.editor}>
          <Panel id="left" collapsible minSize={140} defaultSize={14} data-separator="active" className={styles.panel}>
            <div className={styles.panelContent}>
              <PanelHeader title="Explorer" />
              <div className={styles.panelBody}>
                <SceneExplorer />
              </div>
            </div>
          </Panel>
          <Panel id="middle">
            <div className={styles.panelContent}>
              <Group orientation="vertical" className={styles.middleGroup}>
                <CanvasPanel />
                <Panel id="horizontal" className={styles.panel}>
                  <div className={styles.panelContent}>
                    <PanelHeader title="Assets" />
                    <Assets />
                  </div>
                </Panel>
              </Group>
            </div>
          </Panel>
          <Panel collapsible={true} id="right" minSize={180} defaultSize={19} className={styles.panel}>
            <div className={styles.panelContent}>
              <PanelHeader title="Properties" />
              <div className={styles.panelBody}>
                <PropertiesPanel />
              </div>
            </div>
          </Panel>
        </Group>
      </div>
      <StatusBar />
    </div>
  )
}

export default Editor
