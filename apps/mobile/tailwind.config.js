/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        primary: { DEFAULT: "#4338CA", dark: "#3730A3", soft: "#EEF0FF" },
        bg: "#F6F6F3",
        card: "#FFFFFF",
        line: "#E4E4DF",
        ink: "#18181B",
        muted: "#6B6B66",
        note: {
          text: { bg: "#EEF0FF", fg: "#3730A3" },
          document: { bg: "#FFEDD5", fg: "#9A3412" },
          image: { bg: "#DCFCE7", fg: "#166534" },
          audio: { bg: "#FCE7F3", fg: "#9D174D" },
          task: { bg: "#FEF3C7", fg: "#92400E" },
        },
      },
      fontFamily: {
        heading: ["SpaceGrotesk_700Bold"],
        "heading-medium": ["SpaceGrotesk_500Medium"],
        body: ["Inter_400Regular"],
        "body-medium": ["Inter_500Medium"],
        "body-semibold": ["Inter_600SemiBold"],
      },
      minHeight: { touch: "44px" },
      minWidth: { touch: "44px" },
    },
  },
  plugins: [],
};
