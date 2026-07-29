import React, { useEffect, useState } from 'react'
import { AdminDashboard, PublicForm } from './views/PortalViews'
import { getRoute, subscribeToRouteChange } from './router'

export function App() {
  const [route, setRoute] = useState(getRoute)
  useEffect(() => subscribeToRouteChange(setRoute), [])
  return route === 'admin' ? <AdminDashboard /> : <PublicForm />
}
