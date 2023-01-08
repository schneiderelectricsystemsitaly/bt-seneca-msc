"use strict";

const testTraces = [
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 d9 3e 40 80 08 c2"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 01 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 10 00 6b 00 01 02 00 05 ff ff",
		"answer": "19 10 00 6b 00 01 73 cd"
	},
	{
		"request": "19 10 00 6b 00 01 02 00 06 ff ff",
		"answer": "19 10 00 6b 00 01 73 cd"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 01 59 86"
	},
	{
		"request": "19 03 00 66 00 01 67 cd",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c c0 00 3a 2f c0 00 3a 2f c0 00 3a 2f c3 65"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 02 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 02 19 87"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c 80 00 39 76 c0 00 3a 2f 60 00 39 ed 07 67"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c 80 00 39 76 c0 00 3a 2f c0 00 3a 2f a4 06"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c 80 00 39 76 c0 00 3a 2f 80 00 39 76 71 0c"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 03 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 03 d8 47"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c 2d 5c 3c 86 2d 5c 3c 86 b6 d8 3c 4a b6 03"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c 47 74 3c 11 2d 5c 3c 86 47 74 3c 11 96 2b"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c 88 7c 3b f9 2d 5c 3c 86 88 7c 3b f9 08 68"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 04 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 04 99 85"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c f4 e3 c0 ea f4 e3 c0 ea f4 e3 c0 ea 15 8c"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c f4 e3 c0 ea ec e4 c0 ea f4 e3 c0 ea 63 e6"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c f4 e3 c0 ea ec e4 c0 ea ec e4 c0 ea d4 87"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c fc e3 c0 ea ec e4 c0 ea fc e3 c0 ea 80 59"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c fc e3 c0 ea ec e4 c0 ea f4 e3 c0 ea 82 39"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 05 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 26 19 9c"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 05 58 45"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 7f d2 c3 0d 4a ea"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 06 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 06 18 44"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 d1 00 c3 75 ca 19"
	},
	{
		"request": "19 03 00 66 00 01 67 cd",
		"answer": "19 03 02 20 00 81 86"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 33 d3 c3 76 4d 99"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 07 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 07 d9 84"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 00 90 c3 87 72 8d"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 fe b7 c3 86 32 ae"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 08 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 08 99 80"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 be 27 c2 eb e7 3e"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 bb ad c2 eb c6 18"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 09 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 09 58 40"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 1f b7 c2 d3 c5 3d"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 47 63 c2 d3 96 65"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 1d 55 c2 d3 64 b3"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 0a ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 0a 18 41"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 6b 5e c6 3e cd b4"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 63 7d c6 3e 3e 1e"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 0b ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 0b d9 81"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 77 29 cf 7c fc 5f"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 60 ef cf 7d d8 16"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 0c ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 0c 98 43"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 34 51 cd ce e8 d7"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 a6 ea cd ce b4 4a"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 f9 ee cd cd a7 9e"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 a5 bc cd ce 54 1e"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 0d ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 0d 59 83"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 54 76 cc b0 c7 6c"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 7c 6e cc b0 4e cb"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 0e ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 0e 19 82"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 4f 44 44 5b 36 b6 43 c7 5f 46"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 0f ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 0f d8 42"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 f0 75 c3 b3 1c 4e c3 c7 a2 f8"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 10 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 10 99 8a"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 5d 6f 44 5b 3e ed 43 c7 37 22"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 11 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 11 58 4a"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 fb b1 45 2f 4f 9a 45 7d 1b 92"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 12 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 12 18 4b"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 c6 b0 45 2a 6d 00 c5 7d 4e 48"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 13 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 13 d9 8b"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 fa ed 45 2f 4e fe 45 7d 06 78"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 14 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 14 98 49"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 42 7c 44 61 4f 9a 45 7d a5 9f"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 15 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 15 59 89"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 7f c0 c3 c0 87 98 c5 72 07 13"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 12 77 c3 cd 9b c1 c5 6b 3c 21"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 9d e8 c3 b7 13 a9 c5 77 69 77"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 82 d0 c3 ad f6 d6 c5 7b ce eb"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 57 89 c3 d4 4b 14 c5 67 d3 1e"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 17 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 17 d8 48"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 41 06 44 2e 29 53 43 47 26 86"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 18 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 18 98 4c"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 ac 2f c4 45 25 a5 c3 47 e9 3e"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 19 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 19 59 8c"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 4f 92 44 2e 35 c6 43 47 65 7f"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 1a ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 1a 19 8d"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 af 82 43 67 29 53 43 47 b1 33"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 1b ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 1b d8 4d"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 46 a7 c4 13 25 a5 c3 47 27 0d"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 1c ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 1c 99 8f"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 cc 98 43 67 35 c6 43 47 5b 73"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 1d ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 1d 58 4f"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 70 e5 43 9a 36 b6 43 c7 90 be"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 1e ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 1e 18 4e"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 04 34 c7 06 1c 4e c3 c7 71 15"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 1f ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 1f d9 8e"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 6e df 43 9a 3e ed 43 c7 f9 8e"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 20 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 20 99 9e"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 df ef 43 89 36 b6 43 c7 f5 45"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 21 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 21 58 5e"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 6a 1e c5 dd 1c 4e c3 c7 18 82"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 22 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 22 18 5f"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 e5 ed 43 89 3e ed 43 c7 26 5d"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 23 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 23 d9 9f"
	},
	{
		"request": "19 03 00 00 00 04 47 d1",
		"answer": "19 03 08 7f 00 01 00 00 2c 00 01 ad cb"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 24 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 24 98 5d"
	},
	{
		"request": "19 03 00 a4 00 02 86 30",
		"answer": "19 03 04 6a 48 3d d5 2e f3"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 25 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 25 59 9d"
	},
	{
		"request": "19 03 00 96 00 04 a7 fd",
		"answer": "19 03 08 00 00 00 00 00 00 00 00 eb 77"
	},
	{
		"request": "19 10 00 d2 00 02 04 00 00 40 80 ff ff",
		"answer": "19 10 00 d2 00 02 e2 29"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 65 ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 65 58 6d"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 d2 00 02 67 ea",
		"answer": "19 03 04 00 00 40 80 52 52"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 28 98 58"
	},
	{
		"request": "19 10 00 d2 00 02 04 00 00 41 20 ff ff",
		"answer": "19 10 00 d2 00 02 e2 29"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 66 ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 66 18 6c"
	},
	{
		"request": "19 03 00 d2 00 02 67 ea",
		"answer": "19 03 04 00 00 41 20 53 ba"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 80 00 f9 86"
	},
	{
		"request": "19 10 00 d4 00 02 04 00 00 40 a0 b0 18",
		"answer": "19 10 00 d4 00 02 02 28"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 67 ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 67 d9 ac"
	},
	{
		"request": "19 03 00 d4 00 02 87 eb",
		"answer": "19 03 04 00 00 41 20 53 ba"
	},
	{
		"request": "19 10 00 d4 00 02 04 70 a4 3f 9d 0a da",
		"answer": "19 10 00 d4 00 02 02 28"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 68 ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 68 99 a8"
	},
	{
		"request": "19 03 00 d4 00 02 87 eb",
		"answer": "19 03 04 66 66 40 86 2c c7"
	},
	{
		"request": "19 10 00 dc 00 02 04 66 66 40 86 ff ff",
		"answer": "19 10 00 dc 00 02 83 ea"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 69 ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 69 58 68"
	},
	{
		"request": "19 03 00 dc 00 02 06 29",
		"answer": "19 03 04 66 66 40 86 2c c7"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 6a ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 6a 18 69"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 6b ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 6b d9 a9"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 6c ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 6c 98 6b"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 6e ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 6e 19 aa"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 6d ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 6d 59 ab"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 6f ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 6f d8 6a"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 70 ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 70 99 a2"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 71 ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 71 58 62"
	},
	{
		"request": "19 10 00 e4 00 02 04 00 00 41 c8 ff ff",
		"answer": "19 10 00 e4 00 02 02 27"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 72 ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 72 18 63"
	},
	{
		"request": "19 03 00 e4 00 02 87 e4",
		"answer": "19 03 04 00 00 41 c8 53 f4"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 27 d8 5c"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 cc e7 40 80 dd 35"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 75 ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 75 59 a1"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 cd 76 40 80 8d 24"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 78 ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 78 98 64"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 7b ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 7b d8 65"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 c7 4b 40 80 1f 30"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 cc 58 40 80 ec d1"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 7e ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 7e 18 66"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 cb c8 40 80 ed 88"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 81 ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 81 58 26"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 ca a9 40 80 bd aa"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 84 ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 84 98 25"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 c5 9c 40 80 ae b0"
	},
	{
		"request": "19 10 00 d8 00 02 04 00 00 41 f0 ff ff",
		"answer": "19 10 00 d8 00 02 c2 2b"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 87 ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 87 d8 24"
	},
	{
		"request": "19 03 00 d8 00 02 47 e8",
		"answer": "19 03 04 00 00 41 f0 52 26"
	},
	{
		"request": "19 10 00 fe 00 04 08 01 4d 00 00 01 4e 00 00 ff ff",
		"answer": "19 10 00 fe 00 04 a3 e2"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 88 ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 09 00 01 ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 01 4d 00 00 01 4e 00 00 d6 54"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 aa af 40 80 43 ab"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 c5 0c 40 80 ae 9d"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 c9 89 40 80 bc 24"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 cb 39 40 80 bc 7b"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 c7 db 40 80 1f 1d"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 c6 bc 40 80 af 3e"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 c4 7d 40 80 ff 7a"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 c3 5e 40 80 0f c4"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 c8 6b 40 80 1d ee"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 c6 2c 40 80 af 13"
	},
	{
		"request": "19 10 00 e4 00 02 04 00 00 41 f0 ff ff",
		"answer": "19 10 00 e4 00 02 02 27"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 c2 ce 40 80 0e 15"
	},
	{
		"request": "19 10 00 c0 00 02 04 00 00 41 20 ff ff",
		"answer": "19 10 00 c0 00 02 42 2c"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 7d 41 40 77 5b ac"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 10 00 fe 00 04 08 00 06 00 00 00 07 00 00 d3 67",
		"answer": "19 10 00 fe 00 04 a3 e2"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 88 90 b9",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 09 00 01 d0 dd",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 10 00 6b 00 01 02 00 06 84 89",
		"answer": "19 10 00 6b 00 01 73 cd"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 06 00 00 00 07 00 00 3c b6"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 06 00 00 00 07 00 00 3c b6"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 06 00 00 00 07 00 00 3c b6"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 06 00 00 00 07 00 00 3c b6"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 06 00 00 00 07 00 00 3c b6"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 06 00 00 00 07 00 00 3c b6"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 06 00 00 00 07 00 00 3c b6"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 06 00 00 00 07 00 00 3c b6"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 06 00 00 00 07 00 00 3c b6"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 06 00 00 00 07 00 00 3c b6"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 06 00 00 00 07 00 00 3c b6"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 06 00 00 00 07 00 00 3c b6"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 06 00 00 00 07 00 00 3c b6"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 10 00 fc 00 02 04 00 64 00 00 c3 c1",
		"answer": "19 10 00 fc 00 02 82 20"
	},
	{
		"request": "19 10 00 fe 00 04 08 00 28 00 00 00 28 00 00 2c ac",
		"answer": "19 10 00 fe 00 04 a3 e2"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 89 51 79",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 09 00 02 90 dc",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 10 00 6b 00 01 02 00 06 84 89",
		"answer": "19 10 00 6b 00 01 73 cd"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 28 00 00 00 28 00 00 c3 7d"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 28 00 00 00 28 00 00 c3 7d"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 28 00 00 00 28 00 00 c3 7d"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 28 00 00 00 28 00 00 c3 7d"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 28 00 00 00 28 00 00 c3 7d"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 28 00 00 00 28 00 00 c3 7d"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 28 00 00 00 28 00 00 c3 7d"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 28 00 00 00 28 00 00 c3 7d"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 28 00 00 00 28 00 00 c3 7d"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 41 c9 40 77 d7 d6"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 41 c9 40 77 d7 d6"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 40 a9 40 77 d6 34"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 41 c9 40 77 d7 d6"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 40 a9 40 77 d6 34"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3f 8b 40 77 6f ea"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3e 6b 40 77 6f e0"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3e 6b 40 77 6f e0"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3d 4c 40 77 df af"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3d 4c 40 77 df af"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3d 4c 40 77 df af"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3d 4c 40 77 df af"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3d 4c 40 77 df af"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3d 4c 40 77 df af"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3d 4c 40 77 df af"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3d 4c 40 77 df af"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3d 4c 40 77 df af"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3d 4c 40 77 df af"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3d 4c 40 77 df af"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3d 4c 40 77 df af"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3d 4c 40 77 df af"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3c 2e 40 77 7f 8d"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3c 2e 40 77 7f 8d"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3c 2e 40 77 7f 8d"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3c 2e 40 77 7f 8d"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3c 2e 40 77 7f 8d"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3c 2e 40 77 7f 8d"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3c 2e 40 77 7f 8d"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3c 2e 40 77 7f 8d"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3c 2e 40 77 7f 8d"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3c 2e 40 77 7f 8d"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3c 2e 40 77 7f 8d"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3c 2e 40 77 7f 8d"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3c 2e 40 77 7f 8d"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3c 2e 40 77 7f 8d"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3b 0e 40 77 7f 33"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 01 5a 94",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 10 00 6b 00 01 02 00 05 c4 88",
		"answer": "19 10 00 6b 00 01 73 cd"
	},
	{
		"request": "19 10 00 6b 00 01 02 00 06 84 89",
		"answer": "19 10 00 6b 00 01 73 cd"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 01 59 86"
	},
	{
		"request": "19 03 00 66 00 01 67 cd",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c c0 00 3a 2f c0 00 3a 2f c0 00 3a 2f c3 65"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 01 59 86"
	},
	{
		"request": "19 03 00 66 00 01 67 cd",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c c0 00 3a 2f c0 00 3a 2f c0 00 3a 2f c3 65"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 01 59 86"
	},
	{
		"request": "19 03 00 66 00 01 67 cd",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c c0 00 3a 2f c0 00 3a 2f c0 00 3a 2f c3 65"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 01 59 86"
	},
	{
		"request": "19 03 00 66 00 01 67 cd",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c c0 00 3a 2f c0 00 3a 2f c0 00 3a 2f c3 65"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 01 59 86"
	},
	{
		"request": "19 03 00 66 00 01 67 cd",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c c0 00 3a 2f c0 00 3a 2f c0 00 3a 2f c3 65"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 01 59 86"
	},
	{
		"request": "19 03 00 66 00 01 67 cd",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c c0 00 3a 2f c0 00 3a 2f c0 00 3a 2f c3 65"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 01 59 86"
	},
	{
		"request": "19 03 00 66 00 01 67 cd",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c c0 00 3a 2f c0 00 3a 2f c0 00 3a 2f c3 65"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 01 59 86"
	},
	{
		"request": "19 03 00 66 00 01 67 cd",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c c0 00 3a 2f c0 00 3a 2f c0 00 3a 2f c3 65"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 01 59 86"
	},
	{
		"request": "19 03 00 66 00 01 67 cd",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c c0 00 3a 2f c0 00 3a 2f c0 00 3a 2f c3 65"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 10 01 08 00 02 04 00 00 00 00 81 39",
		"answer": "19 10 01 08 00 02 c2 2e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 10 01 06 00 02 04 a1 2f 3e bd c2 91",
		"answer": "19 10 01 06 00 02 a3 ed"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 10 00 fc 00 02 04 00 0a 00 00 a2 1c",
		"answer": "19 10 00 fc 00 02 82 20"
	},
	{
		"request": "19 10 00 fe 00 04 08 00 64 00 00 00 64 00 00 60 bf",
		"answer": "19 10 00 fe 00 04 a3 e2"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 89 51 79",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 09 00 02 90 dc",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 10 00 6b 00 01 02 00 06 84 89",
		"answer": "19 10 00 6b 00 01 73 cd"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 64 00 00 00 64 00 00 8f 6e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 64 00 00 00 64 00 00 8f 6e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 64 00 00 00 64 00 00 8f 6e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 64 00 00 00 64 00 00 8f 6e"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 10 00 fe 00 04 08 03 e8 00 00 03 e8 00 00 ac cd",
		"answer": "19 10 00 fe 00 04 a3 e2"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 88 90 b9",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 09 00 01 d0 dd",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 10 00 6b 00 01 02 00 06 84 89",
		"answer": "19 10 00 6b 00 01 73 cd"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 03 e8 00 00 03 e8 00 00 43 1c"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 03 e8 00 00 03 e8 00 00 43 1c"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 03 e8 00 00 03 e8 00 00 43 1c"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 03 e8 00 00 03 e8 00 00 43 1c"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 03 e8 00 00 03 e8 00 00 43 1c"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 03 e8 00 00 03 e8 00 00 43 1c"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 ef e1 40 76 b6 f6"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 03 db 55",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 10 00 fe 00 04 08 07 d0 00 00 07 d0 00 00 94 00",
		"answer": "19 10 00 fe 00 04 a3 e2"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 67 d1 35",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 09 00 01 d0 dd",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 10 00 6b 00 01 02 00 06 84 89",
		"answer": "19 10 00 6b 00 01 73 cd"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 07 d0 00 00 07 d0 00 00 7b d1"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 07 d0 00 00 07 d0 00 00 7b d1"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 07 d0 00 00 07 d0 00 00 7b d1"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 07 d0 00 00 07 d0 00 00 7b d1"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 07 d0 00 00 07 d0 00 00 7b d1"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 07 d0 00 00 07 d0 00 00 7b d1"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 10 00 fc 00 02 04 00 05 00 00 92 1f",
		"answer": "19 10 00 fc 00 02 82 20"
	},
	{
		"request": "19 10 00 fe 00 04 08 20 8d 00 00 20 8e 00 00 30 5d",
		"answer": "19 10 00 fe 00 04 a3 e2"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 89 51 79",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 09 00 02 90 dc",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 10 00 6b 00 01 02 00 06 84 89",
		"answer": "19 10 00 6b 00 01 73 cd"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 20 8d 00 00 20 8e 00 00 df 8c"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 20 8d 00 00 20 8e 00 00 df 8c"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 20 8d 00 00 20 8e 00 00 df 8c"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 20 8d 00 00 20 8e 00 00 df 8c"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 20 8d 00 00 20 8e 00 00 df 8c"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 20 8d 00 00 20 8e 00 00 df 8c"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 20 8d 00 00 20 8e 00 00 df 8c"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 24 9b 4f",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 10 00 6b 00 01 02 00 06 84 89",
		"answer": "19 10 00 6b 00 01 73 cd"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 24 98 5d"
	},
	{
		"request": "19 03 00 66 00 01 67 cd",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 a4 00 02 86 30",
		"answer": "19 03 04 00 5c 3e 11 72 4c"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 24 98 5d"
	},
	{
		"request": "19 03 00 66 00 01 67 cd",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 a4 00 02 86 30",
		"answer": "19 03 04 00 5c 3e 11 72 4c"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 24 98 5d"
	},
	{
		"request": "19 03 00 66 00 01 67 cd",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 a4 00 02 86 30",
		"answer": "19 03 04 00 5c 3e 11 72 4c"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 24 98 5d"
	},
	{
		"request": "19 03 00 66 00 01 67 cd",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 a4 00 02 86 30",
		"answer": "19 03 04 00 5c 3e 11 72 4c"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 24 98 5d"
	},
	{
		"request": "19 03 00 66 00 01 67 cd",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 a4 00 02 86 30",
		"answer": "19 03 04 00 5c 3e 11 72 4c"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	}
];

function uniqBy(a, key) {
	var seen = {};
	return a.filter(function (item) {
		var k = key(item);
		return seen.hasOwnProperty(k) ? false : (seen[k] = true);
	});
}

function sameMessage(trace) {
	return trace["request"] + " -> " + trace["answer"];
}

function GetJsonTraces() {
	testTraces = uniqBy(testTraces, sameMessage);
	return JSON.stringify(testTraces);
}

module.exports = { testTraces, GetJsonTraces };