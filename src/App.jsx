import React, { Suspense, lazy, useEffect, useState } from "react";
import { PublicForm, VerificationPage } from "./views/PortalViews";
import { getRoute, subscribeToRouteChange } from "./router";

// The admin dashboard is the largest part of the app and is never used by
// survey participants, so it loads as a separate chunk on the /admin route.
const AdminDashboard = lazy(() =>
  import("./views/AdminViews").then((m) => ({ default: m.AdminDashboard })),
);

export function App() {
  const [route, setRoute] = useState(getRoute);
  useEffect(() => subscribeToRouteChange(setRoute), []);
  if (route === "admin")
    return (
      <Suspense fallback={null}>
        <AdminDashboard />
      </Suspense>
    );
  if (route === "verification") return <VerificationPage />;
  return <PublicForm />;
}
