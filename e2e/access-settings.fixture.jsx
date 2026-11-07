import React from 'react';
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ProjectPicker} from '../components/ProjectPicker';
import {LanAccessSection} from '../components/desktop/LanAccessSection';
import {BrowserPasswordSection} from '../components/desktop/BrowserPasswordSection';
import {I18nProvider} from '../hooks/useI18n';

// Mirrors DesktopAppSection: one shared password status so saving a password
// makes the network switch usable immediately (and removing one pauses it).
function AccessSettings() {
  const [passwordStatus, setPasswordStatus] = useState(null);
  return <>
    <BrowserPasswordSection onStatusChange={setPasswordStatus}/>
    <LanAccessSection passwordStatus={passwordStatus} onPasswordStatusChange={setPasswordStatus}/>
  </>;
}

const picker = new URLSearchParams(location.search).has('picker');
createRoot(document.getElementById('root')).render(<I18nProvider>
  {picker ? <div className="project-picker-modal-overlay"><div className="project-picker-modal-shell">
    <ProjectPicker variant="modal" recentProjects={Array.from({length:20}, (_,i)=>`C:/projects/project-${i}`)} homeDir="C:/Users/test" selectedCwd={null} selectedProject={null} onSelectCwd={cwd=>window.__selected=cwd}/>
  </div></div> : <div style={{padding:16,maxWidth:460,margin:'auto'}}><AccessSettings/></div>}
</I18nProvider>);
