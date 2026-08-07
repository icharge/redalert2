import React, { useState, useEffect } from "react";
import { Task } from "@puzzl/core/lib/async/Task";
import { HttpRequest } from "@/network/HttpRequest";

interface BreakingNewsProps {
    strings: any;
    url?: string;
}

export const BreakingNews: React.FC<BreakingNewsProps> = ({ strings, url }) => {
    const [news, setNews] = useState<string>();
    useEffect(() => {
        setNews(undefined);
        if (url) {
            const task = new Task(async (cancellationToken) => {
                const html = (await new HttpRequest().fetchHtml(url, cancellationToken)).trim();
                if (html.length) {
                    setNews(html);
                }
            });
            task.start().catch((error) => console.error(error));
            return () => task.cancel();
        }
    }, [url]);
    return news
        ? React.createElement("fieldset", { className: "news" }, React.createElement("legend", null, strings.get("GUI:BreakingNews")), React.createElement("div", {
            dangerouslySetInnerHTML: { __html: news },
        }))
        : null;
};
