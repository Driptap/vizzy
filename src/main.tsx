import { createRoot } from 'react-dom/client';
import App from './App';
import { UpdaterWindow } from './components/UpdaterWindow';
import './index.css';

// The tray opens a second webview at index.html#updater (label "updater"); it
// mounts the lightweight Updates view instead of the full app.
const isUpdaterWindow = window.location.hash === '#updater';

// No StrictMode: its double-mount in dev would tear down and recreate the
// WebGL context, audio stream and MIDI listeners on every load.
createRoot(document.getElementById('root')!).render(
  isUpdaterWindow ? <UpdaterWindow /> : <App />,
);
