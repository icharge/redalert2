const CHANNEL_NAME_MAX_LEN = 30;

export function escapeChannelName(name: string): string {
    return name.split("").map(char => {
        switch (char) {
            case " ": return "_";
            case "%": return "%%";
            case "_": return "%_";
            case "\b": return "%b";
            case "\n": return "%n";
            case "\r": return "%r";
            case ":": return "%=";
            case ",": return "%-";
            default: return char;
        }
    }).join("");
}

export function unescapeChannelName(name: string): string {
    const chars = name.split("");
    let result = "";
    let index = 0;
    while (index < chars.length) {
        const char = chars[index++];
        let next: string;
        let decoded: string;
        if (char === "%") {
            next = chars[index++];
            decoded = next === "b" ? "\b"
                : next === "n" ? "\n"
                    : next === "r" ? "\r"
                        : next === "=" ? ":"
                            : next === "-" ? ","
                                : next;
        }
        else {
            decoded = char === "_" ? " " : char;
        }
        result += decoded;
    }
    return result;
}

export function truncateChannelName(name: string): string {
    const escaped = escapeChannelName(name);
    return escaped.length <= CHANNEL_NAME_MAX_LEN ? escaped : escaped.slice(0, CHANNEL_NAME_MAX_LEN);
}

export function splitChannelArg(text: string): string {
    return text.split(" ").map(escapeChannelName).join(" ");
}
