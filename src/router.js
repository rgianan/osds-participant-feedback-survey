export function getRoute() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/'
  if (path === '/admin' || path === '/checkin') return 'admin'
  return 'public'
}

export function subscribeToRouteChange(listener) {
  const onPopState = () => listener(getRoute())
  window.addEventListener('popstate', onPopState)
  return () => window.removeEventListener('popstate', onPopState)
}
