"use client";

import { useMemo } from "react";
import { useDataStream } from "./data-stream-provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type SourceBucket = "forum" | "youtube" | "tsb" | "web";

type SourceLink = {
  bucket: SourceBucket;
  title: string;
  url: string;
};

type SourcesPayload = {
  top_links: SourceLink[];
};

const bucketLabels: Record<SourceBucket, string> = {
  forum: "Forum",
  youtube: "YouTube",
  tsb: "TSB",
  web: "Web",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const getLatestSources = (dataStream: Array<{ type: string; data?: unknown }>) => {
  for (let index = dataStream.length - 1; index >= 0; index -= 1) {
    const part = dataStream[index];
    if (part?.type !== "data-sources") {
      continue;
    }

    if (!isRecord(part.data)) {
      return { topLinks: [] as SourceLink[] };
    }

    const rawLinks = part.data.top_links;
    if (!Array.isArray(rawLinks)) {
      return { topLinks: [] as SourceLink[] };
    }

    const topLinks: SourceLink[] = [];
    for (const link of rawLinks) {
      if (!isRecord(link)) {
        continue;
      }

      const bucket = link.bucket;
      const title = link.title;
      const url = link.url;

      if (
        (bucket !== "forum" &&
          bucket !== "youtube" &&
          bucket !== "tsb" &&
          bucket !== "web") ||
        typeof title !== "string" ||
        typeof url !== "string"
      ) {
        continue;
      }

      topLinks.push({ bucket, title, url });
    }

    return { topLinks };
  }

  return { topLinks: [] as SourceLink[] };
};

const groupByBucket = (links: SourceLink[]) => {
  const grouped: Record<SourceBucket, SourceLink[]> = {
    forum: [],
    youtube: [],
    tsb: [],
    web: [],
  };

  for (const link of links) {
    grouped[link.bucket].push(link);
  }

  return grouped;
};

export const SourcesButton = () => {
  const { dataStream } = useDataStream();

  const { topLinks } = useMemo(
    () => getLatestSources(dataStream),
    [dataStream]
  );

  const groupedLinks = useMemo(() => groupByBucket(topLinks), [topLinks]);
  const totalCount = topLinks.length;

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" type="button" variant="outline">
          Sources ({totalCount})
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Sources</DialogTitle>
        </DialogHeader>
        {totalCount === 0 ? (
          <p className="text-muted-foreground text-sm">No links returned.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {(
              Object.keys(bucketLabels) as Array<keyof typeof bucketLabels>
            ).map((bucket) => {
              const links = groupedLinks[bucket];
              if (links.length === 0) {
                return null;
              }

              return (
                <div className="flex flex-col gap-2" key={bucket}>
                  <h3 className="font-medium text-sm">{bucketLabels[bucket]}</h3>
                  <div className="flex flex-col gap-2">
                    {links.map((link) => (
                      <a
                        className="text-primary text-sm underline-offset-4 hover:underline"
                        href={link.url}
                        key={link.url}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {link.title || link.url}
                      </a>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
