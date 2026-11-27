# Changelog

## [0.1.9](https://github.com/rome-os/rome/compare/node-core-v0.1.8...node-core-v0.1.9) (2026-11-27)


### Features

* **node-core:** bridge the Computer Use helper ([#2719](https://github.com/rome-os/rome/issues/2719)) ([1604fc9](https://github.com/rome-os/rome/commit/1604fc9fd6ef4d41d54d3c6f39c9ce26eb59de68))
* **node-core:** serve window control on full macOS hosts ([#2767](https://github.com/rome-os/rome/issues/2767)) ([6dc564f](https://github.com/rome-os/rome/commit/6dc564ffc96c181f11e33ed24258f1b71f111116))
* **node:** add a macOS Computer Use permission guide ([#2812](https://github.com/rome-os/rome/issues/2812)) ([143ac29](https://github.com/rome-os/rome/commit/143ac29867660a8bd54ed7c49a8298d216c9e43b))
* **node:** add Audit log view to Rome Node Web UI ([#2542](https://github.com/rome-os/rome/issues/2542)) ([2511b5d](https://github.com/rome-os/rome/commit/2511b5d2579a7e5f8ab9c43edc6c0feb309600bb))
* **rome-node:** add computer-use host for node daemon ([#2565](https://github.com/rome-os/rome/issues/2565)) ([f4fa3ea](https://github.com/rome-os/rome/commit/f4fa3eaa734e9fc959ac68c36a8927cfccb11431))
* **rome-node:** add computer-use protocol bridge ([#2564](https://github.com/rome-os/rome/issues/2564)) ([8f93d6c](https://github.com/rome-os/rome/commit/8f93d6c1cf82ebf481d56782771df56d8b68992b))
* **rome-node:** add macOS native computer-use helper ([#2563](https://github.com/rome-os/rome/issues/2563)) ([ee6ceca](https://github.com/rome-os/rome/commit/ee6cecab4d646392835ced73219cf1abdf8a20a2))
* **rome-node:** add the macOS computer use helper ([#2713](https://github.com/rome-os/rome/issues/2713)) ([4a904d8](https://github.com/rome-os/rome/commit/4a904d86e94aedd9e09665a248fbe25f4c4197f1))
* **rome-node:** bundle macOS computer-use in node builds ([#2566](https://github.com/rome-os/rome/issues/2566)) ([16ecc98](https://github.com/rome-os/rome/commit/16ecc98dd3f5f2dc879da309f4a9b7bc1ffd4e54))
* **rome-node:** bundle the macOS computer-use helper ([#2792](https://github.com/rome-os/rome/issues/2792)) ([a49c3cb](https://github.com/rome-os/rome/commit/a49c3cbd2542e3df908707f10b9fc577ddf5d282))


### Bug Fixes

* **computer-use:** harden approvals, revocation, queueing, web UI, and macOS helper ([#2654](https://github.com/rome-os/rome/issues/2654)) ([ddf7451](https://github.com/rome-os/rome/commit/ddf7451a83f044bfceed71f2d33d690d16936818))
* **node-core:** keep macOS window control in background ([#2797](https://github.com/rome-os/rome/issues/2797)) ([79e2397](https://github.com/rome-os/rome/commit/79e2397de2ba2de7a4d61741db754d5de64d64fc))


### Reverts

* remove computer-use Core & Web integration (Option 1 - Part 1/2) ([#2697](https://github.com/rome-os/rome/issues/2697)) ([b5eef6f](https://github.com/rome-os/rome/commit/b5eef6f8ab8f45dad5bf45451964ea53ea6c4d21))
* remove computer-use macOS helper & Rome Node host (Option 1 - Part 2/2) ([#2700](https://github.com/rome-os/rome/issues/2700)) ([afd09fd](https://github.com/rome-os/rome/commit/afd09fdac09dc8264d9a805d624f5e781b4cf39a))


### Dependencies

* The following workspace dependencies were updated
  * optionalDependencies
    * @rome-os/node-core-darwin-arm64 bumped to 0.1.9

## [0.1.8](https://github.com/rome-os/rome/compare/node-core-v0.1.7...node-core-v0.1.8) (2026-11-11)


### Features

* **desktop:** show Rome Cloud notifications, and stay connected with Computer use off ([#1967](https://github.com/rome-os/rome/issues/1967)) ([3565ef7](https://github.com/rome-os/rome/commit/3565ef7431275a122547207a929ae0717fa32f8d))


### Bug Fixes

* **rome-node:** answer device status from the last check while a new one runs ([#1965](https://github.com/rome-os/rome/issues/1965)) ([0093b10](https://github.com/rome-os/rome/commit/0093b10267f067f0c428d0adb9a5c2692637101e))

## [0.1.7](https://github.com/rome-os/rome/compare/node-core-v0.1.6...node-core-v0.1.7) (2026-11-05)


### Features

* **core:** authenticate to Rome Cloud with signer JWTs ([#1718](https://github.com/rome-os/rome/issues/1718)) ([bd455bf](https://github.com/rome-os/rome/commit/bd455bfcfbd91995a40bc03171fce9c39b699648))

## [0.1.6](https://github.com/rome-os/rome/compare/node-core-v0.1.5...node-core-v0.1.6) (2026-11-03)


### Features

* **rome-node:** local append-only audit log on hosts ([#1647](https://github.com/rome-os/rome/issues/1647)) ([4e0f59f](https://github.com/rome-os/rome/commit/4e0f59fcd0326cdf3b1f9e4327e7f27e8b0274ba))

## [0.1.5](https://github.com/rome-os/rome/compare/node-core-v0.1.4...node-core-v0.1.5) (2026-10-23)


### Features

* let a new chat work in a folder on a connected device ([#1267](https://github.com/rome-os/rome/issues/1267)) ([c327426](https://github.com/rome-os/rome/commit/c3274267262499ebb2a8a9354b962e74c6a00c36))
* **node:** rename and remove devices from the Devices page ([#1286](https://github.com/rome-os/rome/issues/1286)) ([bb3385f](https://github.com/rome-os/rome/commit/bb3385fe2ba53c6ca353973af0c65e5fcf1a8470))

## [0.1.4](https://github.com/rome-os/rome/compare/node-core-v0.1.3...node-core-v0.1.4) (2026-10-21)


### Features

* **desktop:** connect the Mac as a device when it signs in to Rome Cloud ([#1217](https://github.com/rome-os/rome/issues/1217)) ([1df1834](https://github.com/rome-os/rome/commit/1df1834d085d3d1d5b5106795056c6f0f931ae90))

## [0.1.3](https://github.com/rome-os/rome/compare/node-core-v0.1.2...node-core-v0.1.3) (2026-10-16)


### Features

* **node:** give each device a load chart and its own activity page ([#1061](https://github.com/rome-os/rome/issues/1061)) ([68175f9](https://github.com/rome-os/rome/commit/68175f902dd92691241f5e2837f7a49d5924e501))
* **node:** record daemon activity and show it in Settings → Devices ([#1032](https://github.com/rome-os/rome/issues/1032)) ([c3e6a8f](https://github.com/rome-os/rome/commit/c3e6a8f7f0c79de276fa43acfabb511b75dfc62c))

## [0.1.2](https://github.com/rome-os/rome/compare/node-core-v0.1.1...node-core-v0.1.2) (2026-10-10)


### Features

* **node:** send raw bytes between devices and add rome-node cp ([#821](https://github.com/rome-os/rome/issues/821)) ([617a42a](https://github.com/rome-os/rome/commit/617a42abd95dab06e7600ae4e7638dcdb27c5a8c))

## [0.1.1](https://github.com/rome-os/rome/compare/node-core-v0.1.0...node-core-v0.1.1) (2026-09-25)


### Features

* **node:** share a WebSocket daemon and show device status in Settings ([#473](https://github.com/rome-os/rome/issues/473)) ([b0cccab](https://github.com/rome-os/rome/commit/b0cccab2336a7d214489d7ab7d1791a4a4bffbaf))
* **node:** support device-code authorization ([#492](https://github.com/rome-os/rome/issues/492)) ([b2a272d](https://github.com/rome-os/rome/commit/b2a272db7a0d033bcc3e9ce3c199475f43fd8433))
