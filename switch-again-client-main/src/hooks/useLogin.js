import { useState } from "react";
import axios from "axios";
import { useAuthStore} from "../store/useAuthStore.js";

export const useLogin = () => {
    const [isLoading, setIsLoading] = useState(false);
    const [errorMessage, setErrorMessage] = useState('');

    const setAuth = useAuthStore((state) => state.setAuth);
    /**
     * 로그인을 수행하는 함수
     * @param {string} email - 사용자 이메일
     * @param {string} password - 사용자 비밀번호
     * @param {object} options - { onSuccess: function, onError: function, onTimeout: function, timeout: number }
     */
    const login = async (email, password, options = {}) => {
        setIsLoading(true);
        setErrorMessage('');

        const { onSuccess, onError, onTimeout, timeout = 5000 } = options;

        try {
            const response = await axios.post(
                '/api/auth/login',
                { email, password },
                {
                    timeout: timeout,
                    headers: {
                        'Content-Type': 'application/json',
                    }
                }
            );

            const data = response.data;

            if (data.token) {
                setAuth(data.token, data.expiresAt);
                if (onSuccess) onSuccess();
            }

            return data
        } catch (error) {
            if (error.code === 'ECONNABORTED') {
                if (onTimeout) onTimeout();
                setErrorMessage('Timeout: Check your network')
            } else if (error.response) {
                const status = error.response.status;
                if (status === 401) {
                    setErrorMessage('Invalid email or password');
                }
                if (onError) onError();
            } else {
                setErrorMessage('An error occurred. Please try again.');
            }
        } finally {
            setIsLoading(false);
        }
    }

    return { login, isLoading, errorMessage };
}