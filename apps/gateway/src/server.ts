/**
 * Точка входу gateway. Спершу перевіряємо версію Node, і лише потім завантажуємо решту коду.
 *
 * Чому окремий файл: статичні import-и виконуються ДО будь-якого коду модуля. Якби перевірка
 * стояла в start.ts, то на старому Node все впало б раніше — на `import "node:sqlite"`
 * з незрозумілим ERR_UNKNOWN_BUILTIN_MODULE. Динамічний import() виконується лише тоді,
 * коли до нього дійде черга, тобто після перевірки.
 */
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(
    `Gateway потребує Node 22.13 або новіший (вбудований node:sqlite), а запущено ${process.versions.node}.\n` +
      "Виправлення: nvm install 22 && nvm alias default 22 && nvm use 22, потім pnpm install.",
  );
  process.exit(1);
}

await import("./start.ts");
