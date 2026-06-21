import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './styles/global.css'

// Pre-apply saved theme before first paint to avoid flash
try {
  const tp = localStorage.getItem('theme_pref')
  if (tp === 'light' || tp === 'dark') document.documentElement.dataset.theme = tp
} catch { /* ignore */ }

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// PWA: register service worker for offline support + home-screen install
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/invest/sw.js').catch(() => {})
  })
}
