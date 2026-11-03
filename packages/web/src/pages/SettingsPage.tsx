import { Navigate, useLocation } from "react-router-dom";

export default function SettingsPage() {
  // Carry the query so shell flags such as hideSidebar=1 survive the redirect.
  const { search } = useLocation();
  return <Navigate to={{ pathname: "/settings/appearance", search }} replace />;
}
