import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

// No StrictMode: its double-mount in dev would tear down and recreate the
// WebGL context, audio stream and MIDI listeners on every load.
createRoot(document.getElementById('root')!).render(<App />);
