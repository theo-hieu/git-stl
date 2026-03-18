#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>

namespace {

constexpr int kInvalidStlErrorCode = -1;
constexpr int kAsciiStlErrorCode = -2;
constexpr std::uint32_t kBinaryStlHeaderBytes = 80;
constexpr std::uint32_t kTriangleCountBytes = 4;
constexpr std::uint32_t kBinaryStlPreambleBytes =
    kBinaryStlHeaderBytes + kTriangleCountBytes;
constexpr std::uint32_t kTriangleRecordBytes = 50;
constexpr std::uint32_t kNormalBytes = 12;
constexpr std::uint32_t kVertexBytes = 12;
constexpr std::uint32_t kAttributeBytes = 2;
constexpr std::uint32_t kVerticesPerTriangle = 3;
constexpr std::uint32_t kFloatsPerVertex = 3;
constexpr std::uint32_t kFloatsPerTriangle =
    kVerticesPerTriangle * kFloatsPerVertex;

std::uint32_t readU32LE(const std::uint8_t *src) {
  return static_cast<std::uint32_t>(src[0]) |
         (static_cast<std::uint32_t>(src[1]) << 8U) |
         (static_cast<std::uint32_t>(src[2]) << 16U) |
         (static_cast<std::uint32_t>(src[3]) << 24U);
}

float readF32LE(const std::uint8_t *src) {
  const std::uint32_t bits = readU32LE(src);
  float value = 0.0f;
  std::memcpy(&value, &bits, sizeof(value));
  return value;
}

char lowerAscii(std::uint8_t byte) {
  return static_cast<char>(std::tolower(static_cast<unsigned char>(byte)));
}

bool startsWithSolid(const std::uint8_t *data, int length) {
  if (data == nullptr || length < 5) {
    return false;
  }

  int offset = 0;
  while (offset < length && std::isspace(static_cast<unsigned char>(data[offset]))) {
    ++offset;
  }

  if (offset + 5 > length) {
    return false;
  }

  return lowerAscii(data[offset]) == 's' && lowerAscii(data[offset + 1]) == 'o' &&
         lowerAscii(data[offset + 2]) == 'l' && lowerAscii(data[offset + 3]) == 'i' &&
         lowerAscii(data[offset + 4]) == 'd';
}

bool containsFacetKeyword(const std::uint8_t *data, int length) {
  if (data == nullptr || length < 5) {
    return false;
  }

  const int scanLimit = length < 512 ? length : 512;

  for (int index = 0; index <= scanLimit - 5; ++index) {
    if (lowerAscii(data[index]) == 'f' && lowerAscii(data[index + 1]) == 'a' &&
        lowerAscii(data[index + 2]) == 'c' && lowerAscii(data[index + 3]) == 'e' &&
        lowerAscii(data[index + 4]) == 't') {
      return true;
    }
  }

  return false;
}

bool looksLikeAsciiStl(const std::uint8_t *data, int length) {
  if (!startsWithSolid(data, length)) {
    return false;
  }

  if (length < static_cast<int>(kBinaryStlPreambleBytes)) {
    return true;
  }

  const std::uint32_t triangleCount = readU32LE(data + kBinaryStlHeaderBytes);
  const std::uint64_t requiredBytes =
      static_cast<std::uint64_t>(kBinaryStlPreambleBytes) +
      static_cast<std::uint64_t>(triangleCount) * kTriangleRecordBytes;

  if (requiredBytes == static_cast<std::uint64_t>(length)) {
    return false;
  }

  return containsFacetKeyword(data, length);
}

int computeFloatCount(const std::uint8_t *data, int length) {
  if (data == nullptr || length < 0) {
    return kInvalidStlErrorCode;
  }

  if (looksLikeAsciiStl(data, length)) {
    return kAsciiStlErrorCode;
  }

  const auto byteLength = static_cast<std::uint64_t>(length);
  if (byteLength < kBinaryStlPreambleBytes) {
    return kInvalidStlErrorCode;
  }

  const std::uint32_t triangleCount = readU32LE(data + kBinaryStlHeaderBytes);
  const std::uint64_t requiredBytes =
      static_cast<std::uint64_t>(kBinaryStlPreambleBytes) +
      static_cast<std::uint64_t>(triangleCount) * kTriangleRecordBytes;

  if (requiredBytes > byteLength) {
    return kInvalidStlErrorCode;
  }

  const std::uint64_t floatCount =
      static_cast<std::uint64_t>(triangleCount) * kFloatsPerTriangle;
  if (floatCount > static_cast<std::uint64_t>(std::numeric_limits<int>::max())) {
    return kInvalidStlErrorCode;
  }

  return static_cast<int>(floatCount);
}

} // namespace

extern "C" {

int getBinaryStlFloatCount(const std::uint8_t *data, int length) {
  return computeFloatCount(data, length);
}

float *parseBinaryStl(const std::uint8_t *data, int length) {
  const int floatCount = computeFloatCount(data, length);
  if (floatCount <= 0) {
    return nullptr;
  }

  auto *out = static_cast<float *>(
      std::malloc(static_cast<std::size_t>(floatCount) * sizeof(float)));
  if (out == nullptr) {
    return nullptr;
  }

  const int triangleCount = floatCount / static_cast<int>(kFloatsPerTriangle);
  const std::uint8_t *cursor = data + kBinaryStlPreambleBytes;
  int outIndex = 0;

  for (int triangleIndex = 0; triangleIndex < triangleCount; ++triangleIndex) {
    cursor += kNormalBytes;

    for (std::uint32_t vertexIndex = 0; vertexIndex < kVerticesPerTriangle;
         ++vertexIndex) {
      out[outIndex++] = readF32LE(cursor);
      out[outIndex++] = readF32LE(cursor + 4);
      out[outIndex++] = readF32LE(cursor + 8);
      cursor += kVertexBytes;
    }

    cursor += kAttributeBytes;
  }

  return out;
}

} // extern "C"
