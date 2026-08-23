import { useState, useEffect } from "react";

const ScreenContainer = ({ children }) => {
    const DESIGN_WIDTH = 1920;
    const DESIGN_HEIGHT = 1080;

    const [scale, setScale] = useState(1);

    useEffect(() => {
        const handleResize = () => {
            const scaleX = window.innerWidth / DESIGN_WIDTH;
            const scaleY = window.innerHeight / DESIGN_HEIGHT;

            const newScale = Math.min(scaleX, scaleY);
            setScale(newScale);
        }
        handleResize();
        window.addEventListener("resize", handleResize);
        return () => {
            window.removeEventListener("resize", handleResize);
        };
    }, []);

    return (
        <div
            style={{
                width: '100vw',
                height: '100vh',
                backgroundColor: "#000000",
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                overflow: 'hidden',
                margin: 0,
                padding: 0,
            }}
        >
            <div
                style={{
                    width: `${DESIGN_WIDTH}px`,
                    height: `${DESIGN_HEIGHT}px`,
                    flexShrink: 0,
                    position: 'relative',
                    backgroundColor: "#FFFFFF",

                    transform: `scale(${scale})`,
                    transformOrigin: 'center center',
                }}
            >
                {children}
            </div>
        </div>
    );
};

export default ScreenContainer;