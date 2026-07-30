import React, { useEffect, useState } from "react";
import {
  AdminDashboard,
  PublicForm,
  VerificationPage,
} from "./views/PortalViews";
import { getRoute, subscribeToRouteChange } from "./router";

export function App() {
  const [route, setRoute] = useState(getRoute);
  useEffect(() => subscribeToRouteChange(setRoute), []);
  if (route === "admin") return <AdminDashboard />;
  if (route === "verification") return <VerificationPage />;
  return <PublicForm />;
}
