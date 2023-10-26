const { mount } = require('@vue/test-utils');
const { SugarL10n } = require('../js/components/SugarL10n.js');

const axiosGetMock = jest.fn().mockResolvedValue({ data: {} });
const i18nextInitMock = jest.fn();

window.axios = {
    get: axiosGetMock,
};

window.i18next = {
    init: i18nextInitMock,
    language: 'en',
    on: jest.fn(),
    getResourceBundle: jest.fn().mockReturnValue({}),
};

window.requirejs = jest.fn().mockImplementation((dependencies, callback) => {
    callback(window.i18next);
});

describe('SugarL10n.js', () => {
    let wrapper;

    beforeEach(() => {
        jest.clearAllMocks();
        wrapper = mount(SugarL10n);
    });

    // tests for loadLanguageFile method
    it('should load language file and initialize i18next', async () => {
        const enStrings = require('../locales/en.json');
        // Mock a successful response from axios.get
        const mockResponse = {
            data: enStrings,
        };

        // Mock the subscribeLanguageChange method
        const subscribeLanguageChangeMock = jest.spyOn(wrapper.vm, 'emitLocalized');

        await axiosGetMock.mockResolvedValue(mockResponse);

        await wrapper.vm.loadLanguageFile('en');
        await wrapper.vm.$nextTick();


        expect(axiosGetMock).toHaveBeenCalledWith('./locales/en.json');
        expect(i18nextInitMock).toHaveBeenCalledWith({
            lng: 'en',
            fallbackLng: 'en',
            resources: {
                en: {
                    translation: mockResponse.data,
                }
            }
        }, expect.any(Function));

        await wrapper.vm.$nextTick();


        const initCallback = i18nextInitMock.mock.calls[0][1]; // Get the callback function from the mock

        // Manually invoke the callback and perform assertions
        initCallback();

        expect(subscribeLanguageChangeMock).toHaveBeenCalled();
        expect(wrapper.vm.l10n).toEqual(window.i18next);
        expect(wrapper.vm.dictionary).toEqual(enStrings && {});
    });

    it('should load default language file on error', async () => {

        await wrapper.vm.loadLanguageFile('xx'); // Assuming 'xx' language file is not available

        expect(axios.get).toHaveBeenCalledWith('./locales/xx.json');
        expect(axios.get).toHaveBeenCalledWith('./locales/en.json'); // Check if default language file is loaded
        expect(i18next.init).toHaveBeenCalledWith({
            lng: 'en',
            fallbackLng: 'en',
            resources: {
                en: {
                    translation: require('../locales/en.json'),
                }
            }
        }, expect.any(Function));
    });

    // test for subscribeLanguageChange method
    it('should update code, dictionary, emit event on language change', async () => {

        const frStrings = require('../locales/fr.json');
        const mockResponse = {
            data: frStrings,
        };

        const subscribeLanguageChangeMock = jest.spyOn(wrapper.vm, 'emitLocalized');

        await axiosGetMock.mockResolvedValue(mockResponse);

        await wrapper.vm.loadLanguageFile('fr');
        window.i18next.language = 'fr';
        i18nextInitMock.mock.calls[0][1]();
        expect(axios.get).toHaveBeenCalledWith('./locales/fr.json');

        expect(i18next.init).toHaveBeenCalledWith({
            lng: 'fr',
            fallbackLng: 'en',
            resources: {
                fr: {
                    translation: mockResponse.data,
                }
            }
        }, expect.any(Function));

        // Check if the code and dictionary have been updated
        expect(wrapper.vm.code).toEqual('fr');
        expect(wrapper.vm.dictionary).toEqual(frStrings && {});
        expect(subscribeLanguageChangeMock).toHaveBeenCalled();
    });


    // tests for get method
    it('should return the translated string if it exists in the dictionary', () => {
        const enStrings = require('../locales/en.json');
        wrapper.setData({ dictionary: enStrings });

        const result = wrapper.vm.get('ChooseDirectory');
        expect(result).toBe('Choose directory...');
    });

    it('should return the input string if it does not exist in the dictionary', () => {
        const enStrings = require('../locales/en.json');
        wrapper.setData({ dictionary: enStrings });

        const result = wrapper.vm.get('farewell');
        expect(result).toBe('farewell');
    });

    it('should replace parameters in the translated string', () => {
        const enStrings = require('../locales/en.json');
        wrapper.setData({ dictionary: enStrings });

        const result = wrapper.vm.get('ByUser', { user: 'John' });
        expect(result).toBe('by John');
    });


    // tests for localizeTimestamp method
    it('should return "SecondsAgo" when the elapsed time is less than a minute', () => {
        const enStrings = require('../locales/en.json');
        wrapper.setData({ dictionary: enStrings });

        const currentTime = Date.now();
        const timestamp = currentTime - 30 * 1000; // 30 seconds ago

        const result = wrapper.vm.localizeTimestamp(timestamp);
        expect(result).toBe('Seconds ago');
    });

    it('should return a localized time period string for elapsed time', () => {
        const enStrings = require('../locales/en.json');
        wrapper.setData({ dictionary: enStrings });

        const currentTime = Date.now();
        const timestamp = currentTime - (2 * 24 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000); // 2 days and 3 hours ago

        const result = wrapper.vm.localizeTimestamp(timestamp);
        expect(result.trim()).toBe('2 days, 3 hours ago');

    });

});