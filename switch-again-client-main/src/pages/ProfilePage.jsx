import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../store/useAuthStore";
import { useEffect } from "react";


export default function ProfilePage() {
    const navigate = useNavigate();
    const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

    useEffect(() => {
        if (!isAuthenticated()) {
            navigate("/login", { replace: true });
        }
    }, [isAuthenticated, navigate])

    return (
        <div style={{ color: "white", fontSize: "24px" }}>
            This is the profile page. You are logged in!
        </div>
    );

}