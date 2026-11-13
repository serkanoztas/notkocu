import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { parseHHmm } from "@notkocu/shared";
import { COURSE_COLORS, type DraftCourse } from "../lib/scheduleDraft";

export const DAY_LABELS = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"] as const;
const HOUR_HEIGHT = 56;
const AXIS_WIDTH = 32;
const LOW_CONFIDENCE = 0.8;

export interface BlockRef {
  courseId: string;
  sessionIndex: number;
}

interface Props {
  courses: DraftCourse[];
  selected: BlockRef | null;
  onSelect: (ref: BlockRef) => void;
}

export function ScheduleGrid({ courses, selected, onSelect }: Props) {
  const [width, setWidth] = useState(0);

  const { days, firstHour, lastHour } = useMemo(() => {
    let maxDay = 4; // Mon-Fri by default; Sat/Sun columns appear only when used
    let min = 8 * 60;
    let max = 17 * 60;
    for (const c of courses) {
      for (const s of c.sessions) {
        maxDay = Math.max(maxDay, s.day);
        min = Math.min(min, parseHHmm(s.start));
        max = Math.max(max, parseHHmm(s.end));
      }
    }
    return { days: maxDay + 1, firstHour: Math.floor(min / 60), lastHour: Math.ceil(max / 60) };
  }, [courses]);

  const colWidth = width > 0 ? (width - AXIS_WIDTH) / days : 0;
  const hours = Array.from({ length: lastHour - firstHour + 1 }, (_, i) => firstHour + i);
  const top = (hhmm: string) => ((parseHHmm(hhmm) - firstHour * 60) / 60) * HOUR_HEIGHT;

  return (
    <View className="rounded-3xl border border-line bg-card p-3" onLayout={(e) => setWidth(e.nativeEvent.layout.width - 24)}>
      <View className="flex-row" style={{ paddingLeft: AXIS_WIDTH }}>
        {Array.from({ length: days }, (_, d) => (
          <Text key={d} className="flex-1 text-center font-body-medium text-sm text-ink">
            {DAY_LABELS[d]}
          </Text>
        ))}
      </View>
      <View style={{ height: (lastHour - firstHour) * HOUR_HEIGHT + 8, marginTop: 6 }}>
        {hours.map((h) => (
          <View key={h} style={{ position: "absolute", top: (h - firstHour) * HOUR_HEIGHT, left: 0, right: 0 }}>
            <Text className="font-body text-xs text-muted" style={{ position: "absolute", top: -7 }}>
              {String(h).padStart(2, "0")}
            </Text>
            <View className="bg-line" style={{ height: 1, marginLeft: AXIS_WIDTH }} />
          </View>
        ))}
        {colWidth > 0
          ? courses.flatMap((course, ci) =>
              course.sessions.map((s, si) => {
                const color = COURSE_COLORS[ci % COURSE_COLORS.length]!;
                const low = course.confidence < LOW_CONFIDENCE;
                const isSelected = selected?.courseId === course.id && selected.sessionIndex === si;
                const height = Math.max(top(s.end) - top(s.start), 28);
                return (
                  <Pressable
                    key={`${course.id}:${si}`}
                    accessibilityRole="button"
                    accessibilityLabel={`${course.name || course.code} ${DAY_LABELS[s.day]} ${s.start}`}
                    onPress={() => onSelect({ courseId: course.id, sessionIndex: si })}
                    style={{
                      position: "absolute",
                      left: AXIS_WIDTH + s.day * colWidth + 2,
                      width: colWidth - 4,
                      top: top(s.start) + 1,
                      height: height - 2,
                      borderRadius: 10,
                      padding: 4,
                      overflow: "hidden",
                      backgroundColor: low ? "#FEF3C7" : `${color}26`,
                      borderWidth: low || isSelected ? 2 : 0,
                      borderStyle: low ? "dashed" : "solid",
                      borderColor: low ? "#92400E" : color,
                    }}
                  >
                    <Text numberOfLines={2} className="font-body-semibold text-xs" style={{ color: low ? "#92400E" : color }}>
                      {course.name || course.code || "?"}
                    </Text>
                    {s.room ? (
                      <Text numberOfLines={1} className="font-body text-xs text-muted">
                        {s.room}
                      </Text>
                    ) : null}
                  </Pressable>
                );
              }),
            )
          : null}
      </View>
    </View>
  );
}
