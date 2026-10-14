/**
 * 中国主要城市的经纬度表（按省 / 直辖市分组）。
 *
 * 为什么内置而不是调地理编码服务：
 *   鸿蒙上没有 GMS 定位，只能手动选城市；
 *   而地理编码接口（含 open-meteo 的 geocoding）在国内网络下不稳，
 *   首页天气这种小功能不该依赖它。内置数据永远可用。
 *
 * 覆盖：4 个直辖市 + 主要省份的地级市。够日常使用；
 *       如果缺你所在的城市，可以往对应省份的 cities 里加一行。
 */
export interface CityEntry {
  name: string;
  lat: number;
  lon: number;
}

export interface ProvinceEntry {
  province: string;
  cities: CityEntry[];
}

export const PROVINCES: ProvinceEntry[] = [
  {
    province: '直辖市',
    cities: [
      { name: '北京', lat: 39.9042, lon: 116.4074 },
      { name: '上海', lat: 31.2304, lon: 121.4737 },
      { name: '天津', lat: 39.3434, lon: 117.3616 },
      { name: '重庆', lat: 29.563, lon: 106.5516 },
    ],
  },
  {
    province: '广东',
    cities: [
      { name: '东莞', lat: 23.0207, lon: 113.7518 },
      { name: '广州', lat: 23.1291, lon: 113.2644 },
      { name: '深圳', lat: 22.5431, lon: 114.0579 },
      { name: '珠海', lat: 22.271, lon: 113.5767 },
      { name: '佛山', lat: 23.0219, lon: 113.1214 },
      { name: '惠州', lat: 23.1115, lon: 114.4162 },
      { name: '中山', lat: 22.5176, lon: 113.3928 },
      { name: '江门', lat: 22.5787, lon: 113.0815 },
      { name: '肇庆', lat: 23.0469, lon: 112.4653 },
      { name: '汕头', lat: 23.3535, lon: 116.6822 },
      { name: '湛江', lat: 21.2707, lon: 110.3594 },
      { name: '茂名', lat: 21.6633, lon: 110.9255 },
      { name: '韶关', lat: 24.8101, lon: 113.5972 },
      { name: '梅州', lat: 24.2886, lon: 116.1226 },
      { name: '清远', lat: 23.6817, lon: 113.0562 },
      { name: '揭阳', lat: 23.5497, lon: 116.3729 },
      { name: '潮州', lat: 23.6567, lon: 116.6226 },
      { name: '河源', lat: 23.7437, lon: 114.7004 },
      { name: '阳江', lat: 21.8581, lon: 111.9822 },
      { name: '云浮', lat: 22.9151, lon: 112.0444 },
      { name: '汕尾', lat: 22.7857, lon: 115.3753 },
    ],
  },
  {
    province: '浙江',
    cities: [
      { name: '杭州', lat: 30.2741, lon: 120.1551 },
      { name: '宁波', lat: 29.8683, lon: 121.544 },
      { name: '温州', lat: 27.9938, lon: 120.6994 },
      { name: '嘉兴', lat: 30.7522, lon: 120.7555 },
      { name: '绍兴', lat: 30.0303, lon: 120.5802 },
      { name: '金华', lat: 29.0784, lon: 119.6474 },
      { name: '台州', lat: 28.656, lon: 121.4207 },
      { name: '湖州', lat: 30.8927, lon: 120.0864 },
      { name: '丽水', lat: 28.4517, lon: 119.9217 },
      { name: '衢州', lat: 28.9359, lon: 118.8743 },
      { name: '舟山', lat: 29.9853, lon: 122.2072 },
    ],
  },
  {
    province: '江苏',
    cities: [
      { name: '南京', lat: 32.0603, lon: 118.7969 },
      { name: '苏州', lat: 31.2989, lon: 120.5853 },
      { name: '无锡', lat: 31.4912, lon: 120.3119 },
      { name: '常州', lat: 31.8107, lon: 119.9741 },
      { name: '南通', lat: 31.9802, lon: 120.8943 },
      { name: '徐州', lat: 34.2058, lon: 117.2848 },
      { name: '扬州', lat: 32.3942, lon: 119.4129 },
      { name: '盐城', lat: 33.3496, lon: 120.1618 },
      { name: '泰州', lat: 32.4849, lon: 119.9152 },
      { name: '镇江', lat: 32.1878, lon: 119.425 },
      { name: '淮安', lat: 33.5975, lon: 119.0213 },
      { name: '连云港', lat: 34.5967, lon: 119.2216 },
      { name: '宿迁', lat: 33.9631, lon: 118.2753 },
    ],
  },
  {
    province: '山东',
    cities: [
      { name: '济南', lat: 36.6512, lon: 117.1201 },
      { name: '青岛', lat: 36.0671, lon: 120.3826 },
      { name: '烟台', lat: 37.4638, lon: 121.4479 },
      { name: '潍坊', lat: 36.7069, lon: 119.1618 },
      { name: '临沂', lat: 35.1042, lon: 118.3564 },
      { name: '淄博', lat: 36.8131, lon: 118.0548 },
      { name: '济宁', lat: 35.4154, lon: 116.5871 },
      { name: '泰安', lat: 36.1942, lon: 117.0879 },
      { name: '威海', lat: 37.5128, lon: 122.1201 },
      { name: '东营', lat: 37.4341, lon: 118.6746 },
    ],
  },
  {
    province: '河北',
    cities: [
      { name: '石家庄', lat: 38.0428, lon: 114.5149 },
      { name: '唐山', lat: 39.6304, lon: 118.1804 },
      { name: '保定', lat: 38.8740, lon: 115.4646 },
      { name: '廊坊', lat: 39.5377, lon: 116.6835 },
      { name: '邯郸', lat: 36.6253, lon: 114.5391 },
      { name: '秦皇岛', lat: 39.9354, lon: 119.5998 },
      { name: '沧州', lat: 38.3037, lon: 116.8388 },
    ],
  },
  {
    province: '河南',
    cities: [
      { name: '郑州', lat: 34.7466, lon: 113.6254 },
      { name: '洛阳', lat: 34.6197, lon: 112.4540 },
      { name: '开封', lat: 34.7971, lon: 114.3074 },
      { name: '新乡', lat: 35.3030, lon: 113.9268 },
      { name: '南阳', lat: 32.9908, lon: 112.5284 },
    ],
  },
  {
    province: '湖北',
    cities: [
      { name: '武汉', lat: 30.5928, lon: 114.3055 },
      { name: '宜昌', lat: 30.6919, lon: 111.2865 },
      { name: '襄阳', lat: 32.009, lon: 112.1224 },
      { name: '荆州', lat: 30.335, lon: 112.2412 },
    ],
  },
  {
    province: '湖南',
    cities: [
      { name: '长沙', lat: 28.2282, lon: 112.9388 },
      { name: '株洲', lat: 27.8274, lon: 113.1342 },
      { name: '湘潭', lat: 27.8296, lon: 112.9446 },
      { name: '衡阳', lat: 26.8938, lon: 112.5719 },
      { name: '常德', lat: 29.0316, lon: 111.6988 },
    ],
  },
  {
    province: '四川',
    cities: [
      { name: '成都', lat: 30.5728, lon: 104.0668 },
      { name: '绵阳', lat: 31.4677, lon: 104.6796 },
      { name: '德阳', lat: 31.127, lon: 104.398 },
      { name: '宜宾', lat: 28.7513, lon: 104.6308 },
      { name: '南充', lat: 30.8373, lon: 106.1103 },
    ],
  },
  {
    province: '福建',
    cities: [
      { name: '福州', lat: 26.0745, lon: 119.2965 },
      { name: '厦门', lat: 24.4798, lon: 118.0894 },
      { name: '泉州', lat: 24.8741, lon: 118.6757 },
      { name: '漳州', lat: 24.5131, lon: 117.6471 },
      { name: '莆田', lat: 25.4311, lon: 119.0078 },
    ],
  },
  {
    province: '安徽',
    cities: [
      { name: '合肥', lat: 31.8206, lon: 117.2272 },
      { name: '芜湖', lat: 31.3526, lon: 118.4331 },
      { name: '蚌埠', lat: 32.9162, lon: 117.3892 },
      { name: '安庆', lat: 30.5434, lon: 117.0634 },
    ],
  },
  {
    province: '江西',
    cities: [
      { name: '南昌', lat: 28.682, lon: 115.8579 },
      { name: '赣州', lat: 25.8311, lon: 114.9350 },
      { name: '九江', lat: 29.7053, lon: 116.0017 },
      { name: '上饶', lat: 28.4548, lon: 117.9434 },
    ],
  },
  {
    province: '陕西',
    cities: [
      { name: '西安', lat: 34.3416, lon: 108.9398 },
      { name: '宝鸡', lat: 34.3614, lon: 107.2372 },
      { name: '咸阳', lat: 34.3299, lon: 108.7092 },
      { name: '渭南', lat: 34.4994, lon: 109.5102 },
    ],
  },
  {
    province: '辽宁',
    cities: [
      { name: '沈阳', lat: 41.8057, lon: 123.4315 },
      { name: '大连', lat: 38.9140, lon: 121.6147 },
      { name: '鞍山', lat: 41.1087, lon: 122.9946 },
      { name: '锦州', lat: 41.0955, lon: 121.1270 },
    ],
  },
  {
    province: '吉林',
    cities: [
      { name: '长春', lat: 43.8171, lon: 125.3235 },
      { name: '吉林', lat: 43.8378, lon: 126.5494 },
      { name: '延边', lat: 42.8913, lon: 129.5082 },
    ],
  },
  {
    province: '黑龙江',
    cities: [
      { name: '哈尔滨', lat: 45.8038, lon: 126.5349 },
      { name: '齐齐哈尔', lat: 47.3543, lon: 123.9180 },
      { name: '大庆', lat: 46.5895, lon: 125.1037 },
    ],
  },
  {
    province: '山西',
    cities: [
      { name: '太原', lat: 37.8706, lon: 112.5489 },
      { name: '大同', lat: 40.0903, lon: 113.2952 },
      { name: '临汾', lat: 36.0880, lon: 111.5190 },
    ],
  },
  {
    province: '广西',
    cities: [
      { name: '南宁', lat: 22.8170, lon: 108.3665 },
      { name: '桂林', lat: 25.2736, lon: 110.2900 },
      { name: '柳州', lat: 24.3146, lon: 109.4280 },
      { name: '北海', lat: 21.4733, lon: 109.1194 },
    ],
  },
  {
    province: '云南',
    cities: [
      { name: '昆明', lat: 25.0389, lon: 102.7183 },
      { name: '大理', lat: 25.6065, lon: 100.2676 },
      { name: '丽江', lat: 26.8721, lon: 100.2299 },
      { name: '西双版纳', lat: 22.0085, lon: 100.7973 },
    ],
  },
  {
    province: '贵州',
    cities: [
      { name: '贵阳', lat: 26.6470, lon: 106.6302 },
      { name: '遵义', lat: 27.7256, lon: 106.9272 },
    ],
  },
  {
    province: '海南',
    cities: [
      { name: '海口', lat: 20.0444, lon: 110.1999 },
      { name: '三亚', lat: 18.2528, lon: 109.5119 },
    ],
  },
  {
    province: '甘肃',
    cities: [
      { name: '兰州', lat: 36.0611, lon: 103.8343 },
      { name: '天水', lat: 34.5809, lon: 105.7249 },
    ],
  },
  {
    province: '内蒙古',
    cities: [
      { name: '呼和浩特', lat: 40.8414, lon: 111.7519 },
      { name: '包头', lat: 40.6574, lon: 109.8403 },
      { name: '乌兰浩特', lat: 46.0728, lon: 122.0489 },
      { name: '鄂尔多斯', lat: 39.6086, lon: 109.7810 },
      { name: '赤峰', lat: 42.2586, lon: 118.8883 },
      { name: '通辽', lat: 43.6524, lon: 122.2437 },
      { name: '呼伦贝尔', lat: 49.2154, lon: 119.7657 },
      { name: '锡林浩特', lat: 43.9330, lon: 116.0860 },
      { name: '巴彦淖尔', lat: 40.7432, lon: 107.3877 },
      { name: '乌海', lat: 39.6538, lon: 106.7946 },
    ],
  },
  {
    province: '新疆',
    cities: [{ name: '乌鲁木齐', lat: 43.8256, lon: 87.6168 }],
  },
  {
    province: '宁夏',
    cities: [{ name: '银川', lat: 38.4872, lon: 106.2309 }],
  },
  {
    province: '青海',
    cities: [{ name: '西宁', lat: 36.6171, lon: 101.7782 }],
  },
  {
    province: '西藏',
    cities: [{ name: '拉萨', lat: 29.65, lon: 91.1409 }],
  },
  {
    province: '香港',
    cities: [{ name: '香港', lat: 22.3193, lon: 114.1694 }],
  },
  {
    province: '澳门',
    cities: [{ name: '澳门', lat: 22.1987, lon: 113.5439 }],
  },
  {
    province: '台湾',
    cities: [
      { name: '台北', lat: 25.033, lon: 121.5654 },
      { name: '高雄', lat: 22.6273, lon: 120.3014 },
    ],
  },
];

/** 拍平后的全部城市（用于按名字反查坐标） */
export const ALL_CITIES: Array<CityEntry & { province: string }> = PROVINCES.flatMap((p) =>
  p.cities.map((c) => ({ ...c, province: p.province })),
);

/** 按名字找城市 */
export function findCity(name: string): (CityEntry & { province: string }) | undefined {
  return ALL_CITIES.find((c) => c.name === name);
}
