import React from "react";

export const TEST_USERS = ["test1", "test2", "test3", "test4", "test5", "test6", "test7", "test8"];
export const TEST_PASSWORD = "testpass";

interface LoginDebugUiProps {
    onSubmit: (username: string, password: string) => void;
}

export const LoginDebugUi: React.FC<LoginDebugUiProps> = ({ onSubmit }) => React.createElement("div", { className: "login-debug-ui" },
    React.createElement("div", { className: "login-debug-buttons" }, TEST_USERS.map((user) => React.createElement("button", {
        key: user,
        type: "button",
        className: "login-debug-button",
        onClick: () => onSubmit(user, TEST_PASSWORD),
    }, user))));
