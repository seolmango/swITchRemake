import { forwardRef, useState, useEffect, memo } from "react";
import { BUTTON_PALETTE } from "../constants/palette";


const VALIDATION_SCHEMA = {
    email: {
        min: 1, max: 254,
        forbidden: /[^a-zA-Z0-9.@%+\-_]/g,
        format: /^[a-zA-Z0-9_%+-]+(\.[a-zA-Z0-9_%+-]+)*@[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/,
        label: "Email"
    },
    nickname: {
        min: 2, max: 12,
        forbidden: /[^a-zA-Z0-9가-힣_]/g,
        label: "Nickname"
    },
    password: {
        min: 8, max: 20,
        forbidden: /[^a-zA-Z0-9!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/g,
        label: "Password"
    },
    roomName: {
        min: 1, max: 10,
        forbidden: /[^a-zA-Z0-9가-힣_ ]/g,
        label: "Room name"
    },
    roomPassword: {
        min: 1, max: 8,
        forbidden: /[^a-zA-Z0-9!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/g,
        label: "Room password"
    },
    verifyCode: {
        exact: 6,
        forbidden: /[^0-9]/g,
        label: "Verification code"
    },
    roomId: {
        exact: 6,
        forbidden: /[^a-zA-Z0-9]/g,
        label: "Room ID"
    }
};


const validate = (verifyType, currentValue) => {
    const rule = VALIDATION_SCHEMA[verifyType];
    if (!rule) return { isValid: true, errorMessage: "" };
    if (!currentValue) return { isValid: false, errorMessage: `${rule.label} cannot be empty.` };

    const len = currentValue.length;
    if (rule.exact ? len !== rule.exact : (len < rule.min || len > rule.max)) {
        const msg = rule.exact
            ? `${rule.label} must be exactly ${rule.exact} characters.`
            : `${rule.label} must be between ${rule.min} and ${rule.max} characters.`;
        return { isValid: false, errorMessage: msg };
    }

    const invalidChars = currentValue.match(rule.forbidden);
    if (invalidChars) {
        const uniqueChars = [...new Set(invalidChars)];
        return {
            isValid: false,
            errorMessage: `${rule.label} contains invalid characters: ${uniqueChars.join(", ")}.`
        };
    }

    if (rule.format && !rule.format.test(currentValue)) {
        return { isValid: false, errorMessage: `${rule.label} format is invalid.` };
    }

    return { isValid: true, errorMessage: "" };
};

const VALID_COLOR = BUTTON_PALETTE.BLUE.STROKE;
const INVALID_COLOR = BUTTON_PALETTE.RED.STROKE;

export const InputBox = memo(forwardRef(({
                                        width,
                                        height,
                                        x,
                                        y,
                                        type,
                                        placeholder,
                                        fontSize = 16,
                                        value = "",
                                        onChange,
                                        editable = true,
                                        style,
                                        ...props
                                    }, ref) => {
    const [displayValidation, setDisplayValidation] = useState({
        isValid: true,
        errorMessage: ""
    });
    const [isPasswordVisible, setIsPasswordVisible] = useState(false);

    useEffect(() => {
        const delay = value ? 500 : 0;

        const handler = setTimeout(() => {
            setDisplayValidation(validate(type, value));

            if (type === "password") {
                setIsPasswordVisible(false);
            }
        }, delay);

        return () => clearTimeout(handler);
    }, [value, type]);

    const handleTextChange = (e) => {
        let newValue = e.target.value;
        if (type === "password") {
            setIsPasswordVisible(true);
        }
        if (onChange) {
            const immediateResult = validate(type, newValue);
            onChange(newValue, immediateResult.isValid);
        }
    };

    const isAbsolute = x !== undefined && y !== undefined;

    const containerStyle = {
        width: `${width}px`,
        position: isAbsolute ? "absolute" : "relative",
        left: isAbsolute ? `${x}px` : undefined,
        top: isAbsolute ? `${y}px` : undefined,
        transform: isAbsolute ? "translate(-50%, -50%)" : undefined,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        ...style
    };

    const inputStyle = {
        width: "100%",
        height: `${height}px`,
        fontSize: `${fontSize}px`,
        border: "none",
        outline: "none",
        backgroundColor: "transparent",
        color: BUTTON_PALETTE.TEXT.DEFAULT,
        padding: "0 5px",
        boxSizing: "border-box",
        borderBottom: `10px solid ${
            displayValidation.isValid ? VALID_COLOR : INVALID_COLOR
        }`,
        transition: "border-color 0.2s",
        cursor: editable ? "text" : "not-allowed",
        WebkitTextSecurity: (type === "password" && !isPasswordVisible) ? "disc" : "none",
        imeMode: type === "password" ? "disabled" : "auto",
    };

    const errorTextStyle = {
        width: "100%",
        fontSize: `${fontSize * 0.55}px`,
        color: BUTTON_PALETTE.TEXT.DEFAULT,
        minHeight: `${fontSize * 0.6 + 5}px`,
        textAlign: "left",
        userSelect: "none",
        marginTop: "5px",
        position: "absolute",
        top: `${height}px`,
        left: "0",
        pointerEvents: "none"
    };

    return (
        <div
            style={containerStyle}
            onClick={(e) => e.stopPropagation()}
        >
            <input
                ref={ref}
                type={"text"}
                value={value}
                placeholder={placeholder}
                onChange={handleTextChange}
                style={inputStyle}
                readOnly={!editable}
                disabled={!editable}
                {...props}
            />

            <div style={errorTextStyle}>
                {displayValidation.errorMessage}
            </div>
        </div>
    );
}));