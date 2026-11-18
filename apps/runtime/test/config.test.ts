import { describe, expect, it } from "vitest";
import { parseChatArgs, RuntimeEnv } from "../src/config.ts";

describe("parseChatArgs", () => {
  it("--as обов'язковий: від чийого імені працює агент — не вгадуємо", () => {
    expect(() => parseChatArgs([])).toThrow(/--as/);
  });

  it("--as olena; --model перекриває модель зі специфікації; --agent — шлях до yaml", () => {
    expect(parseChatArgs(["--as", "olena"])).toEqual({ sub: "olena" });
    expect(parseChatArgs(["--as", "olena", "--model", "mock", "--agent", "x.yaml"])).toEqual({ sub: "olena", model: "mock", agent: "x.yaml" });
  });

  it("невідомий прапорець → помилка (опечатка не має мовчки ігноруватись)", () => {
    expect(() => parseChatArgs(["--as", "olena", "--modle", "mock"])).toThrow(/--modle/);
  });
});

describe("RuntimeEnv", () => {
  it("без ключа gateway — помилка на старті", () => {
    expect(RuntimeEnv.safeParse({}).success).toBe(false);
  });

  it("дефолти: локальні адреси сервісів, JWT-режим, Keycloak; порожній RUNTIME_NOW — як не задано", () => {
    expect(RuntimeEnv.parse({ RUNTIME_GATEWAY_KEY: "k", RUNTIME_NOW: "" })).toEqual({
      RUNTIME_GATEWAY_KEY: "k",
      GATEWAY_URL: "http://127.0.0.1:8787",
      LISTINGS_URL: "http://127.0.0.1:8788/mcp",
      RELOCATION_URL: "http://127.0.0.1:8789/mcp",
      AUTH_MODE: "jwt",
      IDP_ISSUER: "http://127.0.0.1:8080/realms/relocation-sandbox",
      IDP_CLIENT_ID: "relocation-cli",
      RUNTIME_STS_KEY_PATH: ".secrets/runtime-sts.private.jwk.json",
    });
  });
});
